'use strict';

var VideoBufferAppender = (function VideoBufferAppenderClosure() {
    function VideoBufferAppender() {
        this._isSocketInitialized = false;

        if (!window.MediaSource) {
            console.log('MediaSource API is not available');
            return;
        }

        this._sourceBuffer = null;
        this._mediaSource = new MediaSource();
        this._buffers = [];
        this._bufferLength = 0;

        this._mediaSource.addEventListener(
            'error',
            this._errorHandler.bind(this));

        this._mediaSource.addEventListener(
            'sourceopen',
            this._mediaSourceOpen.bind(this),
            false);
    }

    VideoBufferAppender.prototype.getMediaSource = function getMediaSource() {
        return this._mediaSource;
    };
    
    VideoBufferAppender.prototype._mediaSourceOpen = function sourceOpen(e) {
        if (this._sourceBuffer !== null) {
            return;
        }

        //this._sourceBuffer = document.createElement('source');
        //this._sourceBuffer.type = 'video/mp4';
        //video.appendChild(source);
        
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

    VideoBufferAppender.prototype.append = function append(buffer) {
        if (this._sourceBuffer === null) {
            throw 'VideoBufferAppender not ready';
        }
        
        this._bufferLength += buffer.length;
        this._buffers.push(buffer);

        this._appendBuffers();
    };

    VideoBufferAppender.prototype._appendBuffers = function appendBuffers() {
        if (this._sourceBuffer.updating) {
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
            this._sourceBuffer.appendBuffer(unifiedBuffer);
        } catch (e) {
            this._errorHandler(e);
        }
    };

    VideoBufferAppender.prototype._errorHandler = function errorHandler(e) {
        console.log('error on MediaSourceExtensions');
    };
    
    return VideoBufferAppender;
})();
