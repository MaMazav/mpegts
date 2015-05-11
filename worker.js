'use strict';

importScripts('./lib/require.js');

require.config({
	paths: {
		jdataview: '//jdataview.github.io/dist/jdataview',
		jbinary: '//jdataview.github.io/dist/jbinary',
		async: 'lib/async',
		consoleTime: './shim/console.time',
		consoleWorker: './shim/console.worker'
	},
	shim: {
		consoleTime: {
			deps: ['consoleWorker'],
			exports: 'console'
		},
		consoleWorker: {
			deps: [],
			exports: 'console'
		}
	}
});

require(['async', 'jbinary', './mpegts_to_mp4/mpegts', './mpegts_to_mp4/index', 'consoleTime', 'consoleWorker'],
	function (async, jBinary, MPEGTS, mpegts_to_mp4) {
        var fileIndex = 0;
    
		addEventListener('message', function (event) {
			// processing received sources one by one
			async.eachSeries(event.data, function (msg, callback) {
				jBinary.load(msg.url, MPEGTS, function (err, mpegts) {
					// tell async we can load next one
					callback(err);
					if (err) return;

					console.time('convert');
					var mp4 = mpegts_to_mp4(mpegts);
					console.timeEnd('convert');
					
                        // TODO remove when finishing debug
                        if (true) {
                            postMessage({
                                type: 'saveFile',
                                fileType: 'application/octet-binary',
                                bytes: mp4.view.getBytes(mp4.view.byteLength, 0),
                                fileName: 'serialized_video_' + (fileIndex++) + '.mp4'
                            });
                        }
                        
                        if (false) {
                            mp4.seek(0);
                            var mp4Object = mp4.read('File');
                            postMessage({
                                type: 'saveFile',
                                fileType: 'text/json',
                                bytes: JSON.stringify(mp4Object),
                                fileName: 'mp4_json_' + (fileIndex++) + '.json'
                            });
                        }
                        
					postMessage({
						type: 'video',
						index: msg.index,
						original: msg.url,
						url: mp4.toURI('video/mp4')
					});
				});
			});
		});

		postMessage({type: 'ready'});
	}
);