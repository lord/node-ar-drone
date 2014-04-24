// Converts a video stream into a stream of png buffers. Each 'data' event
// is guaranteed to contain exactly 1 png image.

// @TODO handle ffmpeg exit (and trigger "error" if unexpected)

var Stream      = require('stream').Stream;
var util        = require('util');
var spawn       = require('child_process').spawn;
var PngSplitter = require('./PngSplitter');
var PaVEParser = require('./PaVEParser');

module.exports = PngEncoder;
util.inherits(PngEncoder, Stream);
function PngEncoder(options) {
  Stream.call(this);

  options = options || {};

  this.writable = true;
  this.readable = true;

  this._spawn       = options.spawn || spawn;
  this._imageSize   = options.imageSize || null;
  this._frameRate   = options.frameRate || 5;
  this._pngSplitter = options.pngSplitter || new PngSplitter();
  this._log         = options.log;
  this._ffmpeg      = undefined;
  this._ending      = false;
  this._paveParser  = options.paveParser || new PaVEParser();
  this._framebuffer = {};
  this._pBuffer = [];
  this._iBuffer = [];
  this._ffmpegIdle = true;
  this._framesInFfmpeg = 0;
}

PngEncoder.prototype.write = function(buffer) {
  if (!this._ffmpeg) {
    this._initFfmpegAndPipes();
  }

  return this._paveParser.write(buffer);
};

PngEncoder.prototype._sendNextFrame = function() {
  // console.log('sending frame...')
  if (this._iBuffer.length > 0) {
    var frame = this._iBuffer.pop();
    // console.log('found ibuffer with id ' + frame.frame_number)
    this._ffmpeg.stdin.write(frame.payload);
    this._iBuffer = [];
    this._pBuffer = [];
    this._framesInFfmpeg ++;
  } else if (this._pBuffer.length > 0) {
    // console.log('found pbuffer')
    this._ffmpeg.stdin.write(this._pBuffer.shift().payload);
    this._framesInFfmpeg++;
  } else {
    // console.log('empty buffer');
    this._ffmpegIdle = true;
  }
};

PngEncoder.prototype._initFfmpegAndPipes = function() {
  this._ffmpeg = this._spawnFfmpeg();
  var self = this;
  this._paveParser.on('data', function(data) {
    if (data.frame_type == 1) {
      self._iBuffer.push(data);
    } else {
      self._pBuffer.push(data);
    }

    if (self._ffmpegIdle === true) {
      // self._ffmpegIdle = false;
      self._sendNextFrame();
    }
  });

  // @TODO: Make this more sophisticated for somehow and figure out how it
  // will work with the planned new data recording system.
  if (this._log) {
    this._ffmpeg.stderr.pipe(this._log);
  }

  this._ffmpeg.stdout.on('data', function(data) {
    self._pngSplitter.write(data);
  });

  // this._pngSplitter.on('data', this.emit.bind(this, 'data'));

  this._pngSplitter.on('data', function(data) {
    self._framesInFfmpeg --;
    // console.log('output registered - remaining frames ' + self._framesInFfmpeg);
    self._ffmpegIdle = false;
    self.emit('data', data);
    if (self._framesInFfmpeg < 10) {
      self._sendNextFrame();
    }
  });

  // 'error' can be EPIPE if ffmpeg does not exist. We handle this with the
  // 'exit' event below.
  this._ffmpeg.stdin.on('error', function() {});

  this._ffmpeg.stdin.on('drain', this.emit.bind(this, 'drain'));

  // Since node 0.10, spawn emits 'error' when the child can't be spawned.
  // http://nodejs.org/api/child_process.html#child_process_event_error
  this._ffmpeg.on('error', function(err) {
    if (err.code === 'ENOENT') {
      self.emit('error', new Error('Ffmpeg was not found. Have you installed the ffmpeg package?'));
    } else {
      self.emit('error', new Error('Unexpected error when launching ffmpeg:' + err.toString()));
    }
  });

  this._ffmpeg.on('exit', function(code) {
    if (code === 0) {
      // we expected ffmpeg to exit
      if (self._ending) {
        self.emit('end');
        return;
      }

      self.emit('error', new Error('Unexpected ffmpeg exit with code 0.'));
      return;
    }

    // 127 is used by the OS to indicate that ffmpeg was not found
    // required when using node < 0.10
    if (code === 127) {
      self.emit('error', new Error('Ffmpeg was not found / exit code 127.'));
      return;
    }

    self.emit('error', new Error('Ffmpeg exited with error code: ' + code));
  });
};

PngEncoder.prototype._spawnFfmpeg = function() {
  var ffmpegOptions = [];
  ffmpegOptions.push('-i', '-'); // input flag
  ffmpegOptions.push('-fflags', 'nobuffer')
  ffmpegOptions.push('-f', 'image2pipe'); // format flag
  if(this._imageSize){
    ffmpegOptions.push('-s', this._imageSize); // size flag
  }
  ffmpegOptions.push('-vcodec', 'png'); // codec flag
  // ffmpegOptions.push('-r', this._frameRate); // framerate flag
  ffmpegOptions.push('-'); // output
  // @TODO allow people to configure the ffmpeg path
  return this._spawn('ffmpeg', ffmpegOptions);
};

PngEncoder.prototype.end = function() {
  // No data handled yet? Nothing to do for ending.
  if (!this._ffmpeg) {
    return;
  }

  this._ending = true;
  this._ffmpeg.stdin.end();
};
