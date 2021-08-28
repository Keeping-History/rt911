const johng = {
  count: 0,
  accuracy: 1, // seconds
  clock: false,
  clock12hour: false,
  data: [],
  playing: false,
  clockDisplay: '.timeText',
  byID(id) {
    return document.getElementById(id);
  },
  byClass(id) {
    return document.querySelectorAll(`.${id}`);
  },
  pad(val) {
    return val > 9 ? val : `0${val}`;
  },
  tick() {
    if (this.count < 0 || this.count >= 86400) {
      this.count = 0;
    }
    this.count += this.accuracy;
    this.updateClock();
    this.tickFunction();
  },
  current() {
    return this.count;
  },
  setCurrent(seconds) {
    this.count = seconds;
  },
  tickFunction() {
    return true;
  },
  play() {
    const me = this;
    if (!this.interval) {
      this.interval = setInterval(() => {
        me.tick(me);
      }, this.accuracy * 1000);
      this.playing = true;
    }
  },
  reset() {
    this.count = null;
    clearInterval(this.interval);
    delete this.interval;
    this.clearClock();
  },
  toggle() {
    if (this.interval) {
      this.pause();
    } else {
      this.play();
    }
  },
  move(seconds) {
    const parsedSeconds = parseInt(seconds, 10);
    this.count += parsedSeconds;
    if (this.count < 0) {
      this.count = 0;
    }
    this.updateClock();
  },
  pause() {
    clearInterval(this.interval);
    delete this.interval;
    this.playing = false;
  },
  isPlaying() {
    return this.playing;
  },
  set(data) {
    if (Array.isArray(data)) {
      this.data = data;
    }
  },
  get() {
    return this.data.filter(
      (item) => item.start <= this.count && this.count <= item.end,
    );
  },
  between(breakStart, breakEnd) {
    return this.data.filter(
      (item) => parseInt(breakStart, 10) <= item.start
                && item.end <= parseInt(breakEnd, 10),
    );
  },
  all() {
    return this.data;
  },
  updateClock() {
    jQuery(this.clockDisplay).text(secondsToTimeFormatted(this.current()));
  },
  setClock(hour, min, sec) {
    jQuery(this.clockDisplay).text(secondsToTimeFormatted(0));
  },
  clearClock() {
    if (this.clock) {
      this.setClock(0, 0, 0);
    }
  },
};
