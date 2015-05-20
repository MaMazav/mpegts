'use strict';

var saveToFile;
var addInitAndSaveToFile;

var segmenter = new MpegtsSimpleSegmenter();
var websocketReciever = new MpegtsWebsocketReciever('ws://localhost:8087', segmenter);

var combo = document.getElementById('fragmentSelect');
var video = document.getElementById('demoVideo');
var appender = new MediaSourceVideoBufferAppender(video);
//var appender = new StreamVideoBufferAppender(video);

video.addEventListener('error', function(e) {
    console.log('Video error');
});

var isWaitingForSegment = false;
var streamContext = {};
var allBytes = [];
var allMp4s = [];
var initSegmentPerFragment = [];
var lastInitSegment;

require.config({
	paths: {
		jdataview: '//jdataview.github.io/dist/jdataview',
		jbinary: '//jdataview.github.io/dist/jbinary'
	}
});

require(['jbinary', './mpegts_to_mp4/mpegts', './mpegts_to_mp4/index', './mpegts_to_mp4/mp4.js'],
	function (jBinary, MPEGTS, mpegts_to_mp4, MP4) {
        var fileIndex = 0;
    
        segmenter.getSegment(function(segmentBlob) {
            jBinary.load(segmentBlob, MPEGTS, getSegmentCallback);
        });
    
        /*
		var ajax = new XMLHttpRequest();
		ajax.open('GET', '400k00001-3_serialized.mp4', true);
        ajax.responseType = 'arraybuffer';
        ajax.addEventListener('load', function () {
            var bytes = new Uint8Array(ajax.response);
            appender.append(bytes);
            //var blob = new Blob([ajax.response], { type: 'application/octet-binary' });
            //jBinary.load(blob, MPEGTS, getSegmentCallback);
        });
		ajax.send();
        //*/
    
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
                
                if (streamContext.isFirstSegment) {
                    appender.clear(streamContext.videoCodec);
                    lastInitSegment = mp4;
                }
                initSegmentPerFragment.push(lastInitSegment);
                
                appender.append(bytes);
                allBytes.push(bytes);
                allMp4s.push(mp4);
                
                var comboOption = document.createElement('option');
                comboOption.value = allBytes.length;
                comboOption.innerHTML = 'Fragment #' + allBytes.length;
                combo.appendChild(comboOption);
                
                /*
                var blob = new Blob([bytes], { type: 'application/octet-binary' });
                saveAs(blob, 'serialized_video_' + (fileIndex++) + '.mp4');
                //*/
                
                /*
                mp4.seek(0);
                var mp4Object = mp4.read('File');
                var jsonBlob = new Blob([JSON.stringify(mp4Object)], { type: 'text/json' });
                saveAs(jsonBlob, 'serialized_video_' + (fileIndex++) + '.json');
                //*/
            } else {
                console.log('not enough data to convert');
            }
            
            segmenter.getSegment(function(segmentBlob) {
                jBinary.load(segmentBlob, MPEGTS, getSegmentCallback);
            });
        }
    
        saveToFile = function saveToFile() {
            var selected = combo.value;
            
            if (selected === 'all') {
                var blob = new Blob(allBytes, { type: 'application/octet-binary' });
                saveAs(blob, 'live_video.mp4');

                return;
            }
            
            var mp4 = allMp4s[selected - 1];
            var length = mp4.view.tell();
            var bytes = mp4.view.getBytes(mp4.view.tell(), 0);
            
            var blob = new Blob([bytes], { type: 'application/octet-binary' });
            saveAs(blob, 'live_video_fragment_' + selected + '.m4s');
        };
    
        addInitAndSaveToFile = function addInitAndSaveToFile() {
            var selected = combo.value;

            if (selected === 'all') {
                saveToFile();
                return;
            }

            var segment = getSegmentWithInit();
            if (!segment) {
                return;
            }

            var mp4 = new jBinary(segment.maxByteLength, MP4);
            mp4.write('File', segment.data);
            var bytes = mp4.view.getBytes(mp4.view.tell(), 0);

            var blob = new Blob([bytes], { type: 'application/octet-binary' });
            saveAs(blob, 'live_video_fragment_' + selected + '.mp4');
        };
    }
);
    
function getSegmentWithInit() {
    var selected = combo.value;
    if (selected === 'all') {
        alert('Cannot perform this operation for all fragments');
        return null;
    }

    var mp4 = allMp4s[selected - 1];
    mp4.seek(0);
    var mp4Object = mp4.read('File');

    var init = initSegmentPerFragment[selected - 1];
    init.seek(0);
    var output = init.read('File');

    for (var member in mp4Object) {
        output[member] = mp4Object[member];
    }

    return {
        data: output,
        maxByteLength: mp4.view.byteLength + init.view.byteLength
    };
}

function addInitAndSaveJsonToFile() {
    var selected = combo.value;
    if (selected === 'all') {
        saveJsonToFile();
        return;
    }
    
    var segment = getSegmentWithInit();
    if (!segment) {
        return;
    }
    
    var jsonBlob = new Blob([JSON.stringify(segment.data, null, 2)], { type: 'text/json' });
    saveAs(jsonBlob, 'live_video_fragment_' + selected + '_with_init.json');
}

function saveJsonToFile() {
    var start, end;
    
    var selected = combo.value;
    if (selected === 'all') {
        start = 0;
        end = allMp4s.length;
    } else {
        start = selected - 1;
        end = selected;
    }
    
    var bytes = [];
    for (var i = start; i < end; ++i) {
        var mp4 = allMp4s[i];
        
        mp4.seek(0);
        var mp4Object = mp4.read('File');
        bytes.push(JSON.stringify(mp4Object, null, 2));
    }
    
    var jsonBlob = new Blob(bytes, { type: 'text/json' });
    saveAs(jsonBlob, 'live_video_fragment_' + selected + '.json');
}