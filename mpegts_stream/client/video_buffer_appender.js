'use strict';

var VideoBufferAppender = (function VideoBufferAppenderClosure() {
    function VideoBufferAppender() {
        this._buffers = [];
        this._bufferLength = 0;
    }

    VideoBufferAppender.prototype.append = function append(buffer) {
        this._bufferLength += buffer.length;
        this._buffers.push(buffer);

        this._appendBuffers();
    };

    VideoBufferAppender.prototype._appendBuffers = function appendBuffers() {
        if (!this._isReady()) {
            return;
        }

        var buffers = this._buffers;
        this._buffers = [];

        if (this._bufferLength === 0) {
            return;
        }

        var offset = 0;
        var unifiedBuffer = new Uint8Array(this._bufferLength);
        this._bufferLength = 0;

        for (var i = 0; i < buffers.length; ++i) {
            unifiedBuffer.set(buffers[i], offset);
            offset += buffers[i];
        }

        try {
            this._appendBuffer(unifiedBuffer);
        } catch (e) {
            this._errorHandler(e);
        }
    };
    
    VideoBufferAppender.prototype.clear = function clear() {
        throw 'clear was not implemented';
    };

    VideoBufferAppender.prototype._errorHandler = function errorHandler(e) {
        console.log('error: ' + e);
    };
    
    VideoBufferAppender.prototype._isReady = function isReady() {
        throw 'isReady was not implemented';
    };
    
    VideoBufferAppender.prototype._appendBuffer = function appendBuffer(uint8Array) {
        throw 'appendBuffer was not implemented';
    };
    
    return VideoBufferAppender;
})();

var MediaSourceVideoBufferAppender = (function MediaSourceVideoBufferAppenderClosure() {
    function MediaSourceVideoBufferAppender(videoElement) {
        VideoBufferAppender.call(this);
        
        if (!self.MediaSource) {
            console.log('MediaSource API is not available');
            return;
        }

        this._sourceBuffer = null;
        this._mediaSource = new MediaSource();

        this._mediaSource.addEventListener(
            'error',
            this._errorHandler.bind(this));

        this._mediaSource.addEventListener(
            'sourceopen',
            this._mediaSourceOpen.bind(this),
            false);
        
        var objectUrl = URL.createObjectURL(this._mediaSource);
        videoElement.src = objectUrl;
    }
    
    MediaSourceVideoBufferAppender.prototype = Object.create(VideoBufferAppender.prototype);
    
    MediaSourceVideoBufferAppender.prototype._mediaSourceOpen = function sourceOpen(e) {
        if (this._sourceBuffer !== null) {
            return;
        }
        
        this.clear();

        this._appendBuffers();
    };
    
    MediaSourceVideoBufferAppender.prototype._isReady = function isReady() {
        return !this._sourceBuffer.updating && this._sourceBuffer !== null;
    };
    
    MediaSourceVideoBufferAppender.prototype._appendBuffer = function appendBuffer(uint8Array) {
        this._sourceBuffer.appendBuffer(uint8Array);
    };
    
    MediaSourceVideoBufferAppender.prototype.clear = function clear() {
        if (this._sourceBuffer !== null) {
            this._mediaSource.removeSourceBuffer(this._sourceBuffer);
            this._sourceBuffer = null;
        }
        
        this._sourceBuffer = this._mediaSource.addSourceBuffer('video/mp4; codecs="avc1.64001E, mp4a.40.2"');
        //this._sourceBuffer = this._mediaSource.addSourceBuffer('video/mp4');
        //this._sourceBuffer = this._mediaSource.addSourceBuffer('video/webm; codecs="vp8, vorbis"');

        this._sourceBuffer.addEventListener(
            'updateend',
            this._appendBuffers.bind(this));

        this._sourceBuffer.addEventListener(
            'error',
            this._errorHandler.bind(this));
    };

    return MediaSourceVideoBufferAppender;
})();

var StreamVideoBufferAppender = (function StreamVideoBufferAppender() {
    function StreamVideoBufferAppender(videoElement) {
        VideoBufferAppender.call(this);
        this._videoElement = videoElement;
        this._videoElement.mozFrameBufferLength = 512;
    }
    
    StreamVideoBufferAppender.prototype = Object.create(VideoBufferAppender.prototype);
    
    StreamVideoBufferAppender.prototype._isReady = function isReady() {
        return true;
    };
    
    StreamVideoBufferAppender.prototype._appendBuffer = function appendBuffer(uint8Array) {
        var source = document.createElement('source');
        source.type = 'video/mp4';
        
        var blob = new Blob([uint8Array], { type: 'application/octet-binary' });
        source.src = URL.createObjectURL(blob);

        this._videoElement.appendChild(source);
    };
    
    StreamVideoBufferAppender.prototype.clear = function clear() {
        while (this._videoElement.childNodes.length > 0) {
            this._videoElement.removeChild(this._videoElement.childNodes[i]);
        }
    };

    return StreamVideoBufferAppender;
})();