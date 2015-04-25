'use strict';

var MpegtsWebsocketReciever = (function MpegtsWebsocketRecieverClosure() {
    function MpegtsWebsocketReciever(url, segmenter) {
        this._isSocketInitialized = false;
        this._websocket = new WebSocket(url);
        this._segmenter = segmenter;
        this._websocket.onopen = this._onOpen.bind(this);
    }
    
    MpegtsWebsocketReciever.prototype._onOpen = function onOpen() {
        this._websocket.binaryType = 'arraybuffer';
        this._websocket.onmessage = this._onMessage.bind(this);
    };
    
    MpegtsWebsocketReciever.prototype._onMessage = function onMessage(event) {
        var message = new Uint8Array(event.data);
        
        if (!this._isSocketInitialized) {
            if (message[0] !== 'm'.charCodeAt() ||
                message[1] !== 'p'.charCodeAt() ||
                message[2] !== 't'.charCodeAt() ||
                message[3] !== 's'.charCodeAt() ||
                message[4] !== '.'.charCodeAt() ||
                message[5] !== 'j'.charCodeAt() ||
                message[6] !== 's'.charCodeAt()) {
                
                alert('Wrong websocket protocol');
                this._websocket.close();
                return;
            }
            
            this._isSocketInitialized = true;
            message = message.subarray(7);
        }
        
        this._segmenter.pushData(message);
    };
    
    return MpegtsWebsocketReciever;
})();