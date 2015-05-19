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
    
    var LIVE_MIN_FRAGMENT_SAMPLES = 20;
    var MAX_CONTAINER_OVERHEAD_BYTES = 50000;

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
			samples = videoInfo.pendingSamples || [],
            lastDtsChangeSample = 0,
            lastDtsChangeOffset = 0,
            lastDtsChangeAudioOffset = 0;
        
        videoInfo.oldSpsData = videoInfo.spsData;
        videoInfo.oldPps = videoInfo.pps;
        var dtsChangesCount = videoInfo.pendingDtsChangesCount || 0;
        videoInfo.pendingDtsChangesCount = 0;
        
        videoInfo.spsData = null;
        videoInfo.pps = null;
        videoInfo.lastIDR = videoInfo.lastIDR || 0;

        var pendingStreamLength = (videoInfo.pendingStream || {}).byteLength || 0;
		stream = new jDataView(stream.byteLength + pendingStreamLength + MAX_CONTAINER_OVERHEAD_BYTES);
        if (pendingStreamLength > 0) {
            stream.writeBytes(videoInfo.pendingStream.getBytes(videoInfo.pendingStream.byteLength, 0));
        }
        
        var pendingAudioStreamLength = (videoInfo.pendingAudioStream || {}).byteLength || 0;
        var audioStream = new jBinary(stream.byteLength + pendingAudioStreamLength, ADTS);
        if (pendingAudioStreamLength > 0) {
            audioStream.writeBytes(videoInfo.pendingAudioStream.getBytes(videoInfo.pendingAudioStream.byteLength, 0));
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
                    ++dtsChangesCount;
                    lastDtsChangeSample = samples.length - 1;
                    lastDtsChangeOffset = stream.tell();
                    lastDtsChangeAudioOffset = audioStream.tell();

                    videoInfo.spsData = videoInfo.spsData || videoInfo.pendingSpsData;
                    videoInfo.pps = videoInfo.pps  || videoInfo.pendingPps;

                    videoInfo.pendingSpsData = null;
                    videoInfo.pendingPps = null;
                }
				
				// collecting info from H.264 NAL units
				while (nalStream.tell() < nalStream.view.byteLength) {
					var nalUnit = nalStream.read('NALUnit');
					switch (nalUnit[0] & 0x1F) {
						case 7:
							if (!videoInfo.pendingSpsData) {
                                var nalUnitWithoutNalType = nalUnit.subarray(1);
                                var spsData = {
                                    sps : nalUnit,
                                    spsInfo : new jBinary(nalUnitWithoutNalType, H264).read('SPS')
                                };
                                spsData.width = (spsData.spsInfo.pic_width_in_mbs_minus_1 + 1) * 16,
                                spsData.height =
                                    (2 - spsData.spsInfo.frame_mbs_only_flag) *
                                    (spsData.spsInfo.pic_height_in_map_units_minus_1 + 1) * 16;
								var cropping = spsData.spsInfo.frame_cropping;
								if (cropping) {
									spsData.spsInfo.width -= 2 * (cropping.left + cropping.right);
									spsData.spsInfo.height -= 2 * (cropping.top + cropping.bottom);
								}
                                
                                videoInfo.pendingSpsData = spsData;
							}
							break;

						case 8:
							if (!videoInfo.pendingPps) {
								videoInfo.pendingPps = nalUnit;
							}
							break;
                            
						case 5:
                            videoInfo.lastIDR = samples.length - 1;
							curSample.isIDR = true;
						/* falls through */
						default:
							stream.writeUint32(nalUnit.length);
							stream.writeBytes(nalUnit);
					}
				}
			}
		}
        
        videoInfo.spsData = videoInfo.spsData || videoInfo.oldSpsData || videoInfo.pendingSpsData;
        videoInfo.pps = videoInfo.pps || videoInfo.oldPps || videoInfo.pendingPps;
        
        var profileCompatibility;
        if (videoInfo.spsData) {
            profileCompatibility = parseInt(videoInfo.spsData.spsInfo.constraint_set_flags.join(''), 2);
        }

        var lastIDR;
        
        if (isLiveStream) {
            var isEnoughData = dtsChangesCount >= LIVE_MIN_FRAGMENT_SAMPLES && videoInfo.spsData && videoInfo.pps;
            if (isEnoughData) {
                videoInfo.pendingDtsChangesCount = 0;
                lastIDR = videoInfo.lastIDR;
                videoInfo.lastIDR = 0;
            } else {
                videoInfo.pendingDtsChangesCount = dtsChangesCount;
                
                videoInfo.pendingSpsData = videoInfo.spsData || videoInfo.pendingSpsData;
                videoInfo.pendingPps = videoInfo.pps || videoInfo.pendingPps;
                
                lastDtsChangeSample = 0;
                lastDtsChangeOffset = 0;
                lastDtsChangeAudioOffset = 0;
            }
            
            videoInfo.pendingSamples = samples.slice(lastDtsChangeSample);
            videoInfo.pendingStream = stream.slice(lastDtsChangeOffset, stream.tell());
            videoInfo.pendingAudioStream = audioStream.slice(lastDtsChangeAudioOffset, audioStream.tell());
            
            for (var i = 0; i < videoInfo.pendingSamples.length; ++i) {
                videoInfo.pendingSamples[i].offset -= lastDtsChangeOffset;
            }
            
            if (!isEnoughData) {
                return null;
            }
            
            videoInfo.videoCodec =
                'avc1.' +
                ('0' + videoInfo.spsData.spsInfo.profile_idc.toString(16)).slice(-2) +
                ('0' + profileCompatibility.toString(16)).slice(-2) +
                ('0' + videoInfo.spsData.spsInfo.level_idc.toString(16)).slice(-2);
            
            samples.length = lastDtsChangeSample;
            stream.seek(lastDtsChangeOffset);
            audioStream.seek(lastDtsChangeAudioOffset);
            
            if (videoInfo.startDts === undefined) {
                videoInfo.startDts = samples[0].dts;
            }
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
                
                videoInfo.defaultSampleDuration = videoInfo.defaultSampleDuration || dtsDiff;
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
		
        var sttsEntries = dtsDiffs;
        
		if (dtsDiffsSame) {
			sttsEntries = [{first_chunk: 1, sample_count: sizes.length, sample_delta: dtsDiffs[0].sample_delta}];
		}
        
		// building audio metadata

		var audioStart = stream.tell(),
			audioSize = audioStream.tell(),
			audioSizes = [],
			maxAudioSize = 0;
        
        if (isLiveStream) {
            // TODO: Remove it when audio is supported on live stream
            audioSize = 0;
        }
			
		audioStream.seek(0);
		
		while (audioStream.tell() < audioSize) {
			videoInfo.audioHeader = audioStream.read('ADTSPacket');
			audioSizes.push(videoInfo.audioHeader.data.length);
			if (videoInfo.audioHeader.data.length > maxAudioSize) {
				maxAudioSize = videoInfo.audioHeader.data.length;
			}
			stream.writeBytes(videoInfo.audioHeader.data);
		}

        var audioSttsEntries = [{
            sample_count: audioSizes.length,
            sample_delta: Math.round(duration / audioSizes.length)
        }];
        
		// generating resulting MP4

		var mp4 = new jBinary(stream.byteLength, MP4);
        
        var stblAtoms = {
            stsd: [{
                version: 0,
                flags: 0,
                entries: [{
                    type: 'avc1',
                    data_reference_index: 1,
                    dimensions: {
                        horz: videoInfo.spsData.width,
                        vert: videoInfo.spsData.height
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
                            profileIndication: videoInfo.spsData.spsInfo.profile_idc,
                            profileCompatibility: profileCompatibility,
                            levelIndication: videoInfo.spsData.spsInfo.level_idc,
                            lengthSizeMinusOne: 3,
                            seqParamSets: [videoInfo.spsData.sps],
                            pictParamSets: [videoInfo.pps]
                        }]
                    }
                }]
            }],
            stts: [{
                version: 0,
                flags: 0,
                entries: sttsEntries
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
        };
        
        var audioStblAtoms;
        if (audioSize > 0) {
            var maxBitrate, avgBitrate;
            maxBitrate = Math.round(maxAudioSize / (duration / 90000 / audioSizes.length));
            avgBitrate = Math.round((stream.tell() - audioStart) / (duration / 90000));

            audioStblAtoms = {
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
                                        maxBitrate: maxBitrate,
                                        avgBitrate: avgBitrate
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
                    entries: audioSttsEntries
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
            };
        }
        
        var mp4File;
        
        var isAppendToPreviousFiles = false;
		var creationTime = new Date();

        var mvhd = [{
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
        }];
        
        
        var mdat = [{
            _rawData: stream.getBytes(stream.tell(), 0)
        }];
        
        var moov = [{
            atoms: []
        }];
        
        if (!isLiveStream) {
            mp4File = {
                ftyp: [{
                    major_brand: 'isom',
                    minor_version: 512,
                    compatible_brands: ['isom', 'iso2', 'avc1', 'mp41']
                }],
                mdat: mdat,
                moov: moov
            };
            
            moov[0].atoms.mvhd = mvhd;
        } else {
            var fragment_duration = duration;
            duration = 0;
            mvhd[0].duration = 0;
            
            var HAS_DATA_OFFSET = 0x001;
            var HAS_DURATION = 0x100;
            var HAS_SIZE = 0x200;
            var HAS_FLAGS = 0x400;
            var HAS_PRESENTATION_DECODE_DIFF = 0x800;
            var trunFlags = HAS_DATA_OFFSET | HAS_SIZE | HAS_FLAGS | HAS_PRESENTATION_DECODE_DIFF;
            if (!dtsDiffsSame) {
                trunFlags |= HAS_DURATION;
            }
            
            var isFirstIDR = true;
            var trunSamples = new Array(samples.length - 1);
            for (var i = 0; i < samples.length - 1; ++i) {
                trunSamples[i] = {
                    sample_duration: dtsDiffs[i].sample_delta,
                    sample_size: sizes[i],
                    sample_flags: {
                        sampleNotDependsOnOthers: samples[i].isIDR,
                        sampleDependsOnOthers: !samples[i].isIDR,
                        otherSamplesDependOn: i >= lastIDR || isFirstIDR || samples[i].isIDR,
                        isDifferenceSample: !samples[i].isIDR
                    },
                    sample_composition_time_offset: pts_dts_Diffs[i].sample_offset
                };
                
                if (samples[i].isIDR) {
                    isFirstIDR = true;
                }
            }
            
            if (audioSize > 0) {
                // TODO: Create trunSamples array for audio
            }
            
            var moof = [{
            	atoms: {
            		mfhd: [{
            			sequence_number: 0
            		}],
            		traf: [{
            			atoms: {
            				tfhd: [{
            					flags: 0x20000, // NOTE: I don't know what it means, this bit not mentioned in standard
            					track_ID: 1
            				}],
                            tfdt: [{
                                version: 0,
                                base_media_decode_time: samples[0].dts - videoInfo.startDts,
                            }],
                            trun: [{
                                data_offset: 0, // Placeholder only
                                flags: trunFlags,
                                sample_count: trunSamples.length,
                                samples_array: trunSamples
                            }]
            			}
            		}],
            	}
            }];
            
            var sidx = [{
                version: 0,
                flags: 0,
                earliest_composition_time: 1,
                reference_count: 0,
                references: []
            }];

            if (videoInfo.isCreatedInitializationSegment) {
                videoInfo.isFirstSegment = false;
                
        		isAppendToPreviousFiles = true;
                
                mp4File = {
                    moof: moof,
                    mdat: mdat,
                    sidx: sidx
                };
                
                moof[0].atoms.mfhd[0].sequence_number = ++videoInfo.sequenceNumber;
            } else {
                videoInfo.isFirstSegment = true;
                videoInfo.isCreatedInitializationSegment = true;
            	videoInfo.sequenceNumber = 1;
                moof[0].atoms.mfhd[0].sequence_number = 1;

                // For initialization segment according to BMFF
                moov[0].atoms.mvhd = mvhd;
	            stblAtoms.stts[0].entries = [];
	            stblAtoms.stsc[0].entries = [];
	            stblAtoms.stsz[0].sample_count = 0;
	            stblAtoms.stsz[0].sample_sizes = [];
	            stblAtoms.stco[0].entries = [];
	            delete stblAtoms.stss;
	            delete stblAtoms.ctts;
	            
	            if (audioSize > 0) {
	                audioStblAtoms.stts[0].entries = [];
	                audioStblAtoms.stsc[0].entries = [];
	                audioStblAtoms.stsz[0].sample_count = 0;
	                audioStblAtoms.stsz[0].sample_sizes = [];
	                audioStblAtoms.stco[0].entries = [];
	            }
	            
	            moov[0].atoms.mvex = [{
	                atoms: {
                        /*mehd: [{
                            version: 0,
                            fragment_duration: fragment_duration
                        }],*/
	                    trex: [{
	                        track_ID: 1,
	                        default_sample_description_index: 1,
	                        default_sample_duration: videoInfo.defaultSampleDuration,
	                        default_sample_size: sizes[0],
	                        default_sample_flags: 0
	                    }]
	                }
                }];
	            
	            if (audioSize > 0) {
	                moov[0].atoms.mvex.atoms.trex.push({
	                    track_ID: 2,
	                    default_sample_description_index: 1,
	                    default_sample_duration: videoInfo.defaultSampleDuration,
	                    default_sample_size: sizes[0],
	                    default_sample_flags: 0
	                });
	            }
                
                mp4File = {
                    ftyp: [{
                        major_brand: 'isom',
                        minor_version: 512,
                        compatible_brands: ['isom', 'iso2', 'avc1', 'mp41', 'dash']
                    }],
                    moov: moov,
                    moof: moof,
                    mdat: mdat,
                    sidx: sidx
                };
            }
        }
		
		if (!isAppendToPreviousFiles) {
			moov[0].atoms.trak = [{
				atoms: {
					tkhd: [{
						version: 0,
						flags: 15,
						track_ID: 1,
						duration: duration,
						layer: 0,
						alternate_group: 0,
						volume: 0,
						matrix: {
							a: 1, b: 0, x: 0,
							c: 0, d: 1, y: 0,
							u: 0, v: 0, w: 1
						},
						dimensions: {
							horz: videoInfo.spsData.width,
							vert: videoInfo.spsData.height
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
										atoms: stblAtoms
									}]
								}
							}]
						}
					}]
				}
			}];
	
			if (audioSize > 0) {
				moov[0].atoms.trak.push({
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
											atoms: audioStblAtoms
										}]
									}
								}]
							}
						}]
					}
				});
			}
		}
        
		mp4.write('File', mp4File);
        
        if (isLiveStream) {
            if (!jBinary.hookMoofOffsets || jBinary.hookMoofOffsets.length > 1) {
                throw 'Unexpected hookMoofOffsets count. Expected 1';
            }
            
            if (!jBinary.hookRawDataOffsets || jBinary.hookRawDataOffsets.length > 1) {
                throw 'Unexpected hookRawDataOffsets count. Expected 1';
            }
            
            var moofOffsets = jBinary.hookMoofOffsets[0];
            var rawDataOffset = jBinary.hookRawDataOffsets[0];
            delete jBinary.hookMoofOffsets;
            delete jBinary.hookRawDataOffsets;
            
            if (moofOffsets.length !== 2 || moofOffsets[0] || !moofOffsets[1]) {
                throw 'Expected only offset for track ID 1 in moofOffsets. Audio is not supported';
            }
            
            mp4.seek(moofOffsets[1], function() {
                var dataOffset = rawDataOffset - moofOffsets.moofStart;
                this.write('int32', dataOffset);
            });
        }
		
		return mp4.slice(0, mp4.tell());
	};
}));
