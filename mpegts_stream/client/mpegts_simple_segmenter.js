'use strict';

var MpegtsSimpleSegmenter = (function MpegtsSimpleSegmenterClosure() {
    // Packet size range overcomes two issues:
    // -    Varying size of packet (for added TimeCode, Reed-Solomon error
    //      correction, etc.).
    // -    Errors on transport channel.
    
    var MIN_PACKET_SIZE = 186;
    var MAX_PACKET_SIZE = 220;
    var MAX_BYTE_COUNT_ERROR = 2;
    var DEFAULT_PACKET_SIZE = 188;
    var SYNCHRONIZATION_BYTE = 0x47;

    function MpegtsSimpleSegmenter() {
        this._currentListener = null;
        this._currentListenerThis = null;
        this._buffers = [];
        this._bufferLength = 0;
        this._packetSize = DEFAULT_PACKET_SIZE;
        this._offsetChecked = 0;
        this._isReturnAsBlob = true;
    };
    
    MpegtsSimpleSegmenter.prototype.getSegment = function getSegment(
        callback, callbackThis) {
        
        if (this._currentListener !== null) {
            throw 'Segmenter error: Already waiting for segment';
        }
        
        this._currentListener = callback;
        this._currentListenerThis = callbackThis;
        this._tryDequeueNextSegment();
    };
    
    MpegtsSimpleSegmenter.prototype.pushData = function pushData(data) {
        this._buffers.push(data);
        this._bufferLength += data.length;
        this._offsetChecked += data.length;
        
        if (this._currentListener !== null) {
            this._tryDequeueNextSegment();
        }
    };
    
    MpegtsSimpleSegmenter.prototype._returnAsArrays = function returnAsArrays() {
        // Used for tests
        this._isReturnAsBlob = false;
    };
    
    MpegtsSimpleSegmenter.prototype._tryDequeueNextSegment = function dequeue() {
        var beforeLastPacketOffset = this._getLastFullPacketOffset();
        if (beforeLastPacketOffset < 0) {
            return;
        }
        
        var lastPAT = this._getLastElementaryStreamPacket(beforeLastPacketOffset);
        this._offsetChecked = beforeLastPacketOffset;
        
        if (lastPAT < 0 || lastPAT === this._bufferLength) {
            return;
        }
        
        var result = this._dequeueBytes(lastPAT);
        if (this._isReturnAsBlob) {
            result = new Blob(result, { type: 'application/octet-binary' });
        }
        
        var callback = this._currentListener;
        var callbackThis = this._currentListenerThis;
        this._currentListener = null;
        this._currentListenerThis = null;
        
        callback.call(callbackThis, result);
    };
    
    MpegtsSimpleSegmenter.prototype._dequeueBytes = function dequeueBytes(
        untilOffset) {
        
        var length = this._bufferLength - untilOffset - 1;
        
        var subArrays = [];
        while (this._buffers.length > 0 && length >= this._buffers[0].length) {
            length -= this._buffers[0].length;
            subArrays.push(this._buffers.shift());
        }
        
        if (length > 0) {
            if (this._buffers.length === 0 || length > this._buffers[0].length) {
                throw 'Inconsistent data copy';
            }
            
            subArrays.push(this._buffers[0].subarray(0, length));
            this._buffers[0] = this._buffers[0].subarray(length);
        }
        
        this._bufferLength = untilOffset + 1;
        
        return subArrays;
    };    
    MpegtsSimpleSegmenter.prototype._getLastFullPacketOffset =
        function getLastFullPacketOffset() {
        
        if (this._bufferLength < this._packetSize) {
            return -1;
        }
        
        // Offsets are in opposite direction from last byte of buffer
        var lastPacketOffset = this._bufferLength % this._packetSize;
        var beforeLastPacketOffset = this._getPreviousPacketOffset(
            lastPacketOffset);
        
        if (beforeLastPacketOffset > 0) {
            return beforeLastPacketOffset;
        }
        
        lastPacketOffset = this._resynchronize();
        if (lastPacketOffset < 0) {
            return -1;
        }
        
        beforeLastPacketOffset = this._getPreviousPacketOffset(lastPacketOffset);
        
        if (beforeLastPacketOffset < 0) {
            throw 'Segmenter error: Unexpected state after resynchronize()';
        }
        
        return beforeLastPacketOffset;
    };
    
    MpegtsSimpleSegmenter.prototype._getLastElementaryStreamPacket =
        function _getLastElementaryStreamPacket(startFromPacket) {
        
        var packetOffset = startFromPacket;
        while (packetOffset > 0 && packetOffset < this._offsetChecked) {
            var tsHeader = this._getBytes(packetOffset - 1, 3);
            var isPayloadUnitStart = !!(tsHeader & 0x400000);
            if (isPayloadUnitStart) {
                var payloadStart = packetOffset - 4;
                var isAdaptationFieldExist = !!(tsHeader & 0x000020);
                if (isAdaptationFieldExist) {
                    var adaptationFieldLength = this._getBytes(payloadStart);
                    payloadStart += adaptationFieldLength + 1;
                }

                var firstPayloadBytes = this._getBytes(payloadStart, 3);
                if (firstPayloadBytes === 0x000001) {
                    return packetOffset;
                }

            }

            packetOffset = this._getPreviousPacketOffset(packetOffset);
        }
        
        return -1;
    };
    
    MpegtsSimpleSegmenter.prototype._getPreviousPacketOffset =
        function getPreviousPacketOffset(
            startPacketOffset, minPacketSize, maxPacketSize) {
        
        if (!minPacketSize) {
            minPacketSize = this._packetSize - MAX_BYTE_COUNT_ERROR;
        }
        
        if (!maxPacketSize) {
            maxPacketSize = this._packetSize + MAX_BYTE_COUNT_ERROR;
        }
        // Ensure start of packet by checking synchronization byte existence
        
        var expectedSynchronizationByte = this._getBytes(startPacketOffset);
        if (expectedSynchronizationByte !== SYNCHRONIZATION_BYTE) {
            return -1;
        }
        
        // Ensure another packet exist before the one found, to avoid
        // identifying 0x47 which is not synchronization byte as start of packet
        
        var previousPacketIfNoErrors = startPacketOffset + this._packetSize;
        if (previousPacketIfNoErrors < this._bufferLength) {
            expectedSynchronizationByte = this._getBytes(previousPacketIfNoErrors);
            if (expectedSynchronizationByte === SYNCHRONIZATION_BYTE) {
                return previousPacketIfNoErrors;
            }
        }
        
        // Fallback: If not found synchronization byte, check if there is
        // another synchronization byte in the valid range (may be caused due
        // to error or at resynchronize(), usually at the beginning of the stream
        
        var maxSizeBounded = Math.min(
            maxPacketSize, this._bufferLength - startPacketOffset);
        
        for (var i = minPacketSize; i < maxSizeBounded; ++i) {
            expectedSynchronizationByte = this._getBytes(startPacketOffset + i);
            
            if (expectedSynchronizationByte === SYNCHRONIZATION_BYTE) {
                this._packetSize = i;
                return startPacketOffset + i;
            }
        }
        
        return -1;
    };
    
    MpegtsSimpleSegmenter.prototype._resynchronize = function resynchronize() {
        if (this._bufferLength < MAX_PACKET_SIZE) {
            return -1;
        }
        
        for (var offset = 0; offset < MAX_PACKET_SIZE; ++offset) {
            if (offset > this._bufferLength) {
                return -1;
            }
            
            // Ensure two synchronization bytes exist: one at the expected offset,
            // and another one at the beginning of previous packet. That way we avoid
            // identifying 0x47 which is not synchronization byte as start of packet
            
            var previousPacketOffset = this._getPreviousPacketOffset(
                offset, MIN_PACKET_SIZE, MAX_PACKET_SIZE);
            
            if (previousPacketOffset >= 0) {
                return offset;
            }
        }
        
        return -1;
    };
    
    MpegtsSimpleSegmenter.prototype._getBytes = function getBytes(offset, length) {
        var i, offsetInArray;
        for (i = this._buffers.length - 1; i >= 0; --i) {
            var bufferLen = this._buffers[i].length;
            offsetInArray = bufferLen - offset - 1;
            
            if (offsetInArray >= 0) {
                break;
            }
            
            offset -= bufferLen;
        }
        
        if (i < 0) {
            throw 'Segmenter error: Offset is too large';
        }
        
        if (length === undefined) {
            return this._buffers[i][offsetInArray];
        }
        
        var result = 0;
        while (length > 0 && i < this._buffers.length) {
            result <<= 8;
            result |= this._buffers[i][offsetInArray];
            
            ++offsetInArray;
            --length;
            
            if (offsetInArray > this._buffers[i].length) {
                offsetInArray = 0;
                ++i;
            }
        }
        
        if (length > 0) {
            throw 'Segmenter error: not enough bytes';
        }
        
        return result;
    };
    
    return MpegtsSimpleSegmenter;
})();
