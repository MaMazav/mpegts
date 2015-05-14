'use strict';

var MpegtsWebsocketReciever = (function MpegtsWebsocketRecieverClosure() {
    function MpegtsWebsocketReciever(url, segmenter) {
        this._isSocketInitialized = false;
        this._isClosed = false;
        this._newDataCallback = null;
        this._websocket = new WebSocket(url);
        this._segmenter = segmenter;
        this._websocket.onopen = this._onOpen.bind(this);
    }
    
    MpegtsWebsocketReciever.prototype.setNewDataCallback = function setNewDataCallback(callback) {
        this._newDataCallback = callback;
    };
    
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
                
                if (!this._isClosed) {
                    alert('Wrong websocket protocol');
                    this._websocket.close();
                    this._isClosed = true;
                }
                
                return;
            }
            
            this._isSocketInitialized = true;
            
            self.addEventListener('beforeunload', this._onBeforeUnload.bind(this));
            
            message = message.subarray(7);
        }
        
        this._segmenter.pushData(message);
        
        if (this._newDataCallback) {
            this._newDataCallback();
        }
    };
    
    MpegtsWebsocketReciever.prototype._onBeforeUnload = function onBeforeUnload() {
        if (this._isSocketInitialized) {
            this._isSocketInitialized = false;
            
            if (!this._isClosed) {
                this._websocket.close();
                this._isClosed = true;
            }
        }
    };
    
    return MpegtsWebsocketReciever;
})();