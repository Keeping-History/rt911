var johng = {
    count: 0,
    accuracy: 1, //seconds
    clock: false,
    clock12hour: false,
    data: [],
    playing: false,
    clockDisplay: '.timeText',
    byID: function (id) {
        return document.getElementById(id);
    },
    byClass: function (id) {
        return document.querySelectorAll("." + id);
    },
    pad: function (val) {
        return val > 9 ? val : "0" + val;
    },
    tick: function (me) {
        if (me.count < 0 || me.count >= 86400) {
            me.count = 0;
        }
        me.count += me.accuracy;
        this.updateClock();
        this.tickFunction();
    },
    current: function () {
        return this.count;
    },
    setCurrent: function (seconds) {
        this.count = seconds;
    },
    tickFunction: function () {
        return true;
    },
    play: function () {
        me = this;
        if (!this.interval) {
            this.interval = setInterval(function () {
                me.tick(me);
            }, this.accuracy * 1000);
            this.playing = true;
        }
    },
    reset: function () {
        this.count = null;
        clearInterval(this.interval);
        delete this.interval;
        this.clearClock();
    },
    toggle: function () {
        if (this.interval) {
            this.pause();
        } else {
            this.play();
        }
    },
    move: function (seconds) {
        seconds = parseInt(seconds);
        this.count += seconds;
        if (this.count < 0) {
            this.count = 0;
        }
        this.updateClock();
    },
    pause: function () {
        clearInterval(this.interval);
        delete this.interval;
        this.playing = false;
    },
    isPlaying: function () {
        return this.playing;
    },
    set: function (data) {
        if (Array.isArray(data)) {
            this.data = data;
        }
    },
    get: function () {
        return this.data.filter(
            (item) => item.start <= this.count && this.count <= item.end
        );
    },
    between: function (breakStart, breakEnd) {
        return this.data.filter(
            (item) =>
                parseInt(breakStart) <= item.start &&
                item.end <= parseInt(breakEnd)
        );
    },
    all: function () {
        return this.data;
    },
    updateClock: function () {
        jQuery(this.clockDisplay).text(secondsToTimeFormatted(this.current()));
    },
    setClock: function (hour, min, sec) {
        jQuery(this.clockDisplay).text(secondsToTimeFormatted(0));
    },
    clearClock: function () {
        if (clock) {
            this.setClock(0, 0, 0);
        }
    },
};
