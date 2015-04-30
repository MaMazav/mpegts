(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define(['jdataview', 'jbinary', './mp4', './h264', './pes', './adts'], factory);
    } else if (typeof exports === 'object') {
        // Node. Does not work with strict CommonJS, but
        // only CommonJS-like environments that support module.exports,
        // like Node.
        module.exports = factory(require('jdataview'), require('jbinary'), require('./mp4'), require('./h264'), require('./pes'), require('./adts'));
    } else {
        // Browser globals (root is window)
        root.mpegts_to_mp4 = factory(root.jDataView, root.jBinary, root.MP4, root.H264, root.PES, root.ADTS);
    }
}(this, function (jDataView, jBinary, MP4, H264, PES, ADTS) {
	'use strict';

	return function (mpegts, liveStreamContext) {
        if (liveStreamContext) {
            jBinary.hookPat = liveStreamContext.pat;
            jBinary.hookPmt = liveStreamContext.pmt;
        }
        
		var packets = mpegts.read('File');
        
        if (liveStreamContext) {
            delete jBinary.hookPat;
            delete jBinary.hookPmt;
            liveStreamContext.pat = packets.pat;
            liveStreamContext.pmt = packets.pmt;
        }
        
        var isLiveStream = !!liveStreamContext;
        var videoInfo = liveStreamContext || {};
		
		// extracting and concatenating raw stream parts
		var stream = new jDataView(mpegts.view.byteLength);
		for (var i = 0, length = packets.length; i < length; i++) {
			var packet = packets[i], adaptation = packet.adaptationField, payload = packet.payload;
			if (payload && payload._rawStream) {
				stream.writeBytes(payload._rawStream);
			}
		}
		
		var pesStream = new jBinary(stream.slice(0, stream.tell()), PES),
            paramsSets = videoInfo.pendingParamsSets,
			samples = [],
			audioSamples = [],
            lastDtsChangeSample = 0,
            lastDtsChangeOffset = 0,
            lastDtsChangeAudioOffset = 0,
            dstChangesCount = 0;

        videoInfo.pendingParamsSets = videoInfo.pendingParamsSets || {};
        
        var pendingStreamLength = (videoInfo.pendingStream || {}).byteLength || 0;
		stream = new jDataView(stream.byteLength + pendingStreamLength);
        if (pendingStreamLength > 0) {
            stream.writeBytes(videoInfo.pendingStream.getBytes(0, videoInfo.pendingStream.tell()));
        }
        
        var pendingAudioStreamLength = (videoInfo.pendingAudioStream || {}).byteLength || 0;
        var audioStream = new jBinary(stream.byteLength + pendingAudioStreamLength, ADTS);
        if (pendingAudioStreamLength > 0) {
            audioStream.writeBytes(videoInfo.pendingAudioStream.getBytes(0, videoInfo.pendingAudioStream.tell()));
        }
		
		while (pesStream.tell() < pesStream.view.byteLength) {
			var packet = pesStream.read('PESPacket');

			if (packet.streamId === 0xC0) {
				// 0xC0 means we have got first audio stream
				audioStream.write('blob', packet.data);
			} else
			if (packet.streamId === 0xE0) {
				var nalStream = new jBinary(packet.data, H264),
					pts = packet.pts,
					dts = packet.dts,
					curSample = {offset: stream.tell(), pts: pts, dts: dts !== undefined ? dts : pts};
				
				samples.push(curSample);

                if (dts !== samples[lastDtsChangeSample].dts) {
                    ++dstChangesCount;
                    lastDtsChangeSample = samples.length;
                    lastDtsChangeOffset = stream.offset;
                    lastDtsChangeAudioOffset = audioStream.offset;
                    
                    paramsSets = paramsSets || videoInfo.pendingParamsSets;
                    videoInfo.pendingParamsSets = {};
                }
				
				// collecting info from H.264 NAL units
				while (nalStream.tell() < nalStream.view.byteLength) {
					var nalUnit = nalStream.read('NALUnit');
					switch (nalUnit[0] & 0x1F) {
						case 7:
							if (!videoInfo.pendingParamsSets.sps) {
								videoInfo.pendingParamsSets.sps = nalUnit;
								videoInfo.pendingParamsSets.spsInfo = new jBinary(videoInfo.pendingParamsSets.sps, H264).read('SPS');
								videoInfo.pendingParamsSets.width = (videoInfo.pendingParamsSets.spsInfo.pic_width_in_mbs_minus_1 + 1) * 16;
								videoInfo.pendingParamsSets.height =
                                    (2 - videoInfo.pendingParamsSets.spsInfo.frame_mbs_only_flag) *
                                    (videoInfo.pendingParamsSets.spsInfo.pic_height_in_map_units_minus_1 + 1) * 16;
								var cropping = videoInfo.pendingParamsSets.spsInfo.frame_cropping;
								if (cropping) {
									videoInfo.pendingParamsSets.width -= 2 * (cropping.left + cropping.right);
									videoInfo.pendingParamsSets.height -= 2 * (cropping.top + cropping.bottom);
								}
							}
							break;

						case 8:
							if (!videoInfo.pendingParamsSets.pps) {
								videoInfo.pendingParamsSets.pps = nalUnit;
							}
							break;

						case 5:
							curSample.isIDR = true;
						/* falls through */
						default:
							stream.writeUint32(nalUnit.length);
							stream.writeBytes(nalUnit);
					}
				}
			}
		}
        
        if (isLiveStream) {
            if (!paramsSets) {
                paramsSets = videoInfo.oldParamsSets;
            }
            
            videoInfo.oldParamsSets = paramsSets;
            
            if (dstChangesCount < 3) {
                videoInfo.pendingSamples = samples;
                videoInfo.pendingStream = stream;
                videoInfo.pendingAudioStream = audioStream;
                
                return null;
            }
            
            videoInfo.pendingSamples = samples.slice(lastDtsChangeSample);
            videoInfo.pendingStream = stream.slice(lastDtsChangeOffset);
            videoInfo.pendingAudioStream = audioStream.slice(lastDtsChangeAudioOffset);
            
            samples = samples.slice(0, lastDtsChangeSample);
            stream = stream.slice(0, lastDtsChangeOffset);
            audioStream = audioStream.slice(0, lastDtsChangeAudioOffset);
        }
		
		samples.push({offset: stream.tell()});

		var sizes = [],
			dtsDiffs = [],
			accessIndexes = [],
			pts_dts_Diffs = [],
			current = samples[0],
			frameRate = {sum: 0, count: 0},
			duration = 0;
		
		// calculating PTS/DTS differences and collecting keyframes
		
		for (var i = 0, length = samples.length - 1; i < length; i++) {
			var next = samples[i + 1];
			sizes.push(next.offset - current.offset);
			var dtsDiff = next.dts - current.dts;
			if (dtsDiff) {
				dtsDiffs.push({sample_count: 1, sample_delta: dtsDiff});
				duration += dtsDiff;
				frameRate.sum += dtsDiff;
				frameRate.count++;
			} else {
				dtsDiffs.length++;
			}
			if (current.isIDR) {
				accessIndexes.push(i + 1);
			}
			pts_dts_Diffs.push({
				first_chunk: pts_dts_Diffs.length + 1,
				sample_count: 1,
				sample_offset: current.dtsFix = current.pts - current.dts
			});
			current = next;
		}
		
		frameRate = Math.round(frameRate.sum / frameRate.count);
		
		for (var i = 0, length = dtsDiffs.length; i < length; i++) {
			if (dtsDiffs[i] === undefined) {
				dtsDiffs[i] = {first_chunk: i + 1, sample_count: 1, sample_delta: frameRate};
				duration += frameRate;
				//samples[i + 1].dts = samples[i].dts + frameRate;
			}
		}

		// checking if DTS differences are same everywhere to pack them into one item
		
		var dtsDiffsSame = true;
		
		for (var i = 1, length = dtsDiffs.length; i < length; i++) {
			if (dtsDiffs[i].sample_delta !== dtsDiffs[0].sample_delta) {
				dtsDiffsSame = false;
				break;
			}
		}
		
		if (dtsDiffsSame) {
			dtsDiffs = [{first_chunk: 1, sample_count: sizes.length, sample_delta: dtsDiffs[0].sample_delta}];
		}

		// building audio metadata

		var audioStart = stream.tell(),
			audioSize = audioStream.tell(),
			audioSizes = [],
			maxAudioSize = 0;
			
		audioStream.seek(0);
		
		while (audioStream.tell() < audioSize) {
			videoInfo.audioHeader = audioStream.read('ADTSPacket');
			audioSizes.push(videoInfo.audioHeader.data.length);
			if (videoInfo.audioHeader.data.length > maxAudioSize) {
				maxAudioSize = videoInfo.audioHeader.data.length;
			}
			stream.writeBytes(videoInfo.audioHeader.data);
		}

		// generating resulting MP4

		var mp4 = new jBinary(stream.byteLength, MP4);
		
		var trak = [{
			atoms: {
				tkhd: [{
					version: 0,
					flags: 15,
					track_ID: 1,
					duration: duration,
					layer: 0,
					alternate_group: 0,
					volume: 1,
					matrix: {
						a: 1, b: 0, x: 0,
						c: 0, d: 1, y: 0,
						u: 0, v: 0, w: 1
					},
					dimensions: {
						horz: paramsSets.width,
						vert: paramsSets.height
					}
				}],
				mdia: [{
					atoms: {
						mdhd: [{
							version: 0,
							flags: 0,
							timescale: 90000,
							duration: duration,
							lang: 'und'
						}],
						hdlr: [{
							version: 0,
							flags: 0,
							handler_type: 'vide',
							name: 'VideoHandler'
						}],
						minf: [{
							atoms: {
								vmhd: [{
									version: 0,
									flags: 1,
									graphicsmode: 0,
									opcolor: {r: 0, g: 0, b: 0}
								}],
								dinf: [{
									atoms: {
										dref: [{
											version: 0,
											flags: 0,
											entries: [{
												type: 'url ',
												version: 0,
												flags: 1,
												location: ''
											}]
										}]
									}
								}],
								stbl: [{
									atoms: {
										stsd: [{
											version: 0,
											flags: 0,
											entries: [{
												type: 'avc1',
												data_reference_index: 1,
												dimensions: {
													horz: paramsSets.width,
													vert: paramsSets.height
												},
												resolution: {
													horz: 72,
													vert: 72
												},
												frame_count: 1,
												compressorname: '',
												depth: 24,
												atoms: {
													avcC: [{
														version: 1,
														profileIndication: paramsSets.spsInfo.profile_idc,
														profileCompatibility: parseInt(paramsSets.spsInfo.constraint_set_flags.join(''), 2),
														levelIndication: paramsSets.spsInfo.level_idc,
														lengthSizeMinusOne: 3,
														seqParamSets: [paramsSets.sps],
														pictParamSets: [paramsSets.pps]
													}]
												}
											}]
										}],
										stts: [{
											version: 0,
											flags: 0,
											entries: dtsDiffs
										}],
										stss: [{
											version: 0,
											flags: 0,
											entries: accessIndexes
										}],
										ctts: [{
											version: 0,
											flags: 0,
											entries: pts_dts_Diffs
										}],
										stsc: [{
											version: 0,
											flags: 0,
											entries: [{
												first_chunk: 1,
												samples_per_chunk: sizes.length,
												sample_description_index: 1
											}]
										}],
										stsz: [{
											version: 0,
											flags: 0,
											sample_size: 0,
											sample_count: sizes.length,
											sample_sizes: sizes
										}],
										stco: [{
											version: 0,
											flags: 0,
											entries: [0x28]
										}]
									}
								}]
							}
						}]
					}
				}]
			}
		}];

		if (audioSize > 0) {
			trak.push({
				atoms: {
					tkhd: [{
						version: 0,
						flags: 15,
						track_ID: 2,
						duration: duration,
						layer: 0,
						alternate_group: 1,
						volume: 1,
						matrix: {
							a: 1, b: 0, x: 0,
							c: 0, d: 1, y: 0,
							u: 0, v: 0, w: 1
						},
						dimensions: {
							horz: 0,
							vert: 0
						}
					}],
					mdia: [{
						atoms: {
							mdhd: [{
								version: 0,
								flags: 0,
								timescale: 90000,
								duration: duration,
								lang: 'eng'
							}],
							hdlr: [{
								version: 0,
								flags: 0,
								handler_type: 'soun',
								name: 'SoundHandler'
							}],
							minf: [{
								atoms: {
									smhd: [{
										version: 0,
										flags: 0,
										balance: 0
									}],
									dinf: [{
										atoms: {
											dref: [{
												version: 0,
												flags: 0,
												entries: [{
													type: 'url ',
													version: 0,
													flags: 1,
													location: ''
												}]
											}]
										}
									}],
									stbl: [{
										atoms: {
											stsd: [{
												version: 0,
												flags: 0,
												entries: [{
													type: 'mp4a',
													data_reference_index: 1,
													channelcount: 2,
													samplesize: 16,
													samplerate: 22050,
													atoms: {
														esds: [{
															version: 0,
															flags: 0,
															sections: [
																{
																	descriptor_type: 3,
																	ext_type: 128,
																	length: 34,
																	es_id: 2,
																	stream_priority: 0
																},
																{
																	descriptor_type: 4,
																	ext_type: 128,
																	length: 20,
																	type: 'mpeg4_audio',
																	stream_type: 'audio',
																	upstream_flag: 0,
																	buffer_size: 0,
																	maxBitrate: Math.round(maxAudioSize / (duration / 90000 / audioSizes.length)),
																	avgBitrate: Math.round((stream.tell() - audioStart) / (duration / 90000))
																},
																{
																	descriptor_type: 5,
																	ext_type: 128,
																	length: 2,
																	audio_profile: videoInfo.audioHeader.profileMinusOne + 1,
																	sampling_freq: videoInfo.audioHeader.samplingFreq,
																	channelConfig: videoInfo.audioHeader.channelConfig
																},
																{
																	descriptor_type: 6,
																	ext_type: 128,
																	length: 1,
																	sl: 2
																}
															]
														}]
													}
												}]
											}],
											stts: [{
												version: 0,
												flags: 0,
												entries: [{
													sample_count: audioSizes.length,
													sample_delta: Math.round(duration / audioSizes.length)
												}]
											}],
											stsc: [{
												version: 0,
												flags: 0,
												entries: [{
													first_chunk: 1,
													samples_per_chunk: audioSizes.length,
													sample_description_index: 1
												}]
											}],
											stsz: [{
												version: 0,
												flags: 0,
												sample_size: 0,
												sample_count: audioSizes.length,
												sample_sizes: audioSizes
											}],
											stco: [{
												version: 0,
												flags: 0,
												entries: [0x28 + audioStart]
											}]
										}
									}]
								}
							}]
						}
					}]
				}
			});
		};
		
		var creationTime = new Date();

		mp4.write('File', {
			ftyp: [{
				major_brand: 'isom',
				minor_version: 512,
				compatible_brands: ['isom', 'iso2', 'avc1', 'mp41']
			}],
			moov: [{
				atoms: {
					mvhd: [{
						version: 0,
						flags: 0,
						creation_time: creationTime,
						modification_time: creationTime,
						timescale: 90000,
						duration: duration,
						rate: 1,
						volume: 1,
						matrix: {
							a: 1, b: 0, x: 0,
							c: 0, d: 1, y: 0,
							u: 0, v: 0, w: 1
						},
						next_track_ID: 2
					}],
					trak: trak
				}
			}],
			mdat: [{
				_rawData: stream.getBytes(stream.tell(), 0)
			}]
		});
		
		return mp4.slice(0, mp4.tell());
	};
}));