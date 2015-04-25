'use strict';

function testSegmenter(testName, actions) {
    QUnit.test(testName, function(assert) {
        var allPushedData = [];
        var calledCallbacks = [];
        var segmenter = new MpegtsSimpleSegmenter();
        segmenter._returnAsArrays();
        
        for (var i = 0; i < actions.length; ++i) {
            switch (actions[i].type) {
                case 'push':
                    var dataToPush = concatBuffers(actions[i].data);
                    
                    segmenter.pushData(dataToPush);
                    allPushedData.push(dataToPush);
                    
                    break;
                
                case 'get':
                    var callback = getCallbackMock(i);
                    segmenter.getSegment(callback);
                    break;
                
                default:
                    throw 'Unexpected action ' + actions[i].type + '. Fix test';
            }
        }
        
        var allData = concatBuffers(allPushedData);
        var offset = 0;
        
        for (var i = 0; i < actions.length; ++i) {
            var action = actions[i];
            
            if (action.type !== 'get') {
                continue;
            }
            
            var callbackCallsExpected = action.notExpectedToReturn ? 0 : 1;
            var callbackCallsActual = calledCallbacks[i].calls;
            assert.deepEqual(
                callbackCallsExpected,
                callbackCallsActual,
                'Callback calls count correctness');
            
            if (callbackCallsExpected === 0) {
                continue;
            }
            
            if (callbackCallsActual > 0) {
                var segmentExpected = allData.subarray(
                    offset, offset + action.expectedSegmentLength);
                
                //var reader = new FileReader();
                //reader.addEventListener
                //var buffer = reader.readAsArrayBuffer(calledCallbacks[i].segment);
                //var segmentActual = new Uint8Array(buffer);
                var segmentActual = concatBuffers(calledCallbacks[i].segment);
                
                assert.deepEqual(
                    segmentActual,
                    segmentExpected,
                    'Callback argument correctness (' + segmentExpected.length + ' bytes)');
            }
            
            offset += action.expectedSegmentLength;
        }
        
        function getCallbackMock(index) {
            calledCallbacks[index] = { calls: 0 };
            
            return callbackMock;
            
            function callbackMock(segment) {
                calledCallbacks[index].segment = segment;
                ++calledCallbacks[index].calls;
            }
        }
    });
}

function concatBuffers(buffers) {
    var length = 0;
    for (var i = 0; i < buffers.length; ++i) {
        length += buffers[i].length;
    }
    
    var result = new Uint8Array(length);
    var offset = 0;
    for (var i = 0; i < buffers.length; ++i) {
        result.set(buffers[i], offset);
        offset += buffers[i].length;
    }
    
    return result;
}

function stringToUint8Array(str) {
    var buf = new ArrayBuffer(str.length);
    var bufView = new Uint8Array(buf);

    for (var i=0, strLen=str.length; i<strLen; i++) {
        bufView[i] = str.charCodeAt(i);
    }

    return bufView;
}

function blobToUint8Array(b) {
    var uri = URL.createObjectURL(b),
        xhr = new XMLHttpRequest(),
        i,
        ui8;

    xhr.open('GET', uri, false);
    xhr.send();

    URL.revokeObjectURL(uri);

    ui8 = new Uint8Array(xhr.response.length);

    for (i = 0; i < xhr.response.length; ++i) {
        ui8[i] = xhr.response.charCodeAt(i);
    }

    return ui8;
}

var simplePacketSStartValue = 0;

function simplePacket(length, pid, startValue) {
    var result = new Uint8Array(length);
    
    result[0] = 0x47;
    result[1] = pid >> 8;
    result[2] = pid & 0xFF;
    
    var value = startValue;
    for (var i = 3; i < length; ++i) {
        value += 3;
        value %= 255;
        
        if (value === 0x47) {
            value += 3;
        }
        
        result[i] = value;
    }
    
    return result;
}

testSegmenter('Simple packets', [
    { type: 'push', data: [
        simplePacket(188, 17, 5),
        simplePacket(188, 9, 13),
        simplePacket(188, 0, 61),
        simplePacket(188, 13, 4),
    ] },
    { type: 'get', 'expectedSegmentLength': 188 * 2 }
    ]);

testSegmenter('Simple packets one by one', [
    { type: 'push', data: [ simplePacket(188, 17, 5) ] },
    { type: 'push', data: [ simplePacket(188, 9, 13) ] },
    { type: 'push', data: [ simplePacket(188, 0, 61) ] },
    { type: 'push', data: [ simplePacket(188, 13, 4) ] },
    { type: 'get', 'expectedSegmentLength': 188 * 2 }
    ]);
    
var xhr = new XMLHttpRequest();
xhr.open('GET', '400k00001.ts', false);
xhr.send();
var exampleFile = stringToUint8Array(xhr.response);

testSegmenter('Example file', [
    { type: 'push', data: [
        exampleFile,
        simplePacket(188, 0, 32),
        simplePacket(188, 4, 44)
    ] },
    { type: 'get', 'expectedSegmentLength': exampleFile.length }
    ]);