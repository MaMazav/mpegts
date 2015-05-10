(function () {
	'use strict';

	// requestAnimationFrame polyfill
	window.requestAnimationFrame = window.requestAnimationFrame || window.mozRequestAnimationFrame || window.webkitRequestAnimationFrame || window.msRequestAnimationFrame || setTimeout;

	// preconfiguration using <script>'s data-attributes values
	var scripts = document.getElementsByTagName('script'),
		script = scripts[scripts.length - 1],
		worker = new Worker('worker_raw_mpegts.js'),
		nextIndex = 0,
		sentVideos = 0,
		currentVideo = null,
		videos = [],
		lastOriginal,
		canvas = document.getElementById(script.getAttribute('data-canvas')),
		websocketUrl = script.getAttribute('data-websocket'),
		context = canvas.getContext('2d');
        
    var segmenter = new MpegtsSimpleSegmenter();
    var websocketReciever = new MpegtsWebsocketReciever(websocketUrl, segmenter);

	// drawing new frame
	function nextFrame() {
		if (currentVideo.paused || currentVideo.ended) {
			return;
		}
		context.drawImage(currentVideo, 0, 0);
		requestAnimationFrame(nextFrame);
	}

	worker.addEventListener('message', function (event) {
		var data = event.data, descriptor = '#' + data.index + ': ' + data.original;

		switch (data.type) {
			// worker is ready to convert
			case 'ready':
				getMore();
				return;

			// got debug message from worker
			case 'debug':
				Function.prototype.apply.call(console[data.action], console, data.args);
				return;
                
            case 'notEnoughData':
                --sentVideos;
                if (sentVideos - nextIndex <= 1) {
                    getMore();
                }
                return;
                
            case 'saveFile':
                var blob = new Blob([data.bytes], { type: data.fileType });
                saveAs(blob, data.fileName);
                break;

			// got new converted MP4 video data
			case 'video':
				var video = document.createElement('video'), source = document.createElement('source');
				source.type = 'video/mp4';
				video.appendChild(source);
                
				video.addEventListener('loadedmetadata', function () {
					if (canvas.width !== this.videoWidth || canvas.height !== this.videoHeight) {
						canvas.width = this.width = this.videoWidth;
						canvas.height = this.height = this.videoHeight;
					}
				});

				video.addEventListener('play', function () {
					if (currentVideo !== this) {
						if (!currentVideo) {
							// UI initialization magic to be left in main HTML for unobtrusiveness
							new Function(script.text).call({
								worker: worker,
								canvas: canvas,
								get currentVideo() { return currentVideo }
							});
						}
						console.log('playing ' + descriptor);
						currentVideo = this;
						nextIndex++;
						if (sentVideos - nextIndex <= 1) {
							getMore();
						}
					}
					nextFrame();
				});

				video.addEventListener('ended', function () {
					delete videos[nextIndex - 1];
					if (nextIndex in videos) {
						videos[nextIndex].play();
					}
				});
				if (video.src.slice(0, 5) === 'blob:') {
					video.addEventListener('ended', function () {
						URL.revokeObjectURL(this.src);
					});
				}

				video.src = source.src = data.url;
				video.load();

				(function canplaythrough() {
					console.log('converted ' + descriptor);
					videos[data.index] = this;
					if ((!currentVideo || currentVideo.ended) && data.index === nextIndex) {
						this.play();
					}
				}).call(video);

				return;
		}
	});

	// loading more segments from reciever
	function getMore() {
        
        //setTimeout(function() {
        
        //var suffix = new Uint8Array(188 + 4);
        //suffix[0] = 0x47;
        //suffix[1] = 0;
        //suffix[2] = 0;
        //for (var i = 3; i < 188; ++i) {
        //    suffix[i] = i;
        //}
        //suffix[188] = 0x47;
        //suffix[189] = 13;
        //suffix[190] = 0;
        //suffix[191] = 24;
        
        //segmenter.pushData(suffix);
        
        console.log('Asking for another segment');
        
        segmenter.getSegment(function getSegmentCallback(segmentBlob) {
            worker.postMessage([{
                url: segmentBlob,
                index: sentVideos++
            }]);
            
            console.log('Sent segment to decoder');
        });
        
        //}, 15000);
    }
})();
