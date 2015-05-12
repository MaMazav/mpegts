'use strict';

var segmenter = new MpegtsSimpleSegmenter();
var websocketReciever = new MpegtsWebsocketReciever('ws://localhost:8087', segmenter);
var appender = new VideoBufferAppender();

var objectUrl = window.URL.createObjectURL(appender.getMediaSource());
var video = document.getElementById('demoVideo');
video.src = objectUrl;

var isWaitingForSegment = false;
var streamContext = {};

require.config({
	paths: {
		jdataview: '//jdataview.github.io/dist/jdataview',
		jbinary: '//jdataview.github.io/dist/jbinary'
	}
});

require(['jbinary', './mpegts_to_mp4/mpegts', './mpegts_to_mp4/index'],
	function (jBinary, MPEGTS, mpegts_to_mp4) {
        var fileIndex = 0;
    
        segmenter.getSegment(function(segmentBlob) {
            jBinary.load(segmentBlob, MPEGTS, getSegmentCallback);
        });
    
        function getSegmentCallback(err, mpegts) {
            isWaitingForSegment = false;

            if (err) {
                console.log('error: ' + err);
                return;
            }

            console.log('converting another chunk...');
            var mp4 = mpegts_to_mp4(mpegts, streamContext);

            if (mp4 !== null) {
                console.log('converted');

                var bytes = mp4.view.getBytes();
                appender.append(bytes);
                
                var blob = new Blob([bytes], { type: 'application/octet-binary' });
                //saveAs(blob, 'serialized_video_' + (fileIndex++) + '.mp4');
            } else {
                console.log('not enough data to convert');
            }
            
            segmenter.getSegment(function(segmentBlob) {
                jBinary.load(segmentBlob, MPEGTS, getSegmentCallback);
            });
        }
    }
);