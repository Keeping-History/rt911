
const videos = [
    { "title": "CNN", "url": "https://cdn1.911realtime.org/download/CNN_20010911/playlist.m3u8" },
    { "title": "WTTG", "url": "https://cdn1.911realtime.org/transcoded/wsbk/2001-09-11/WSBK_20010911_040000_Spin_City.m3u8" },
    { "title": "WJLA", "url": "https://cdn1.911realtime.org/download/WJLA_20010911/playlist.m3u8" },
    { "title": "NEWS", "url": "https://cdn1.911realtime.org/transcoded/newsw/2001-09-11/NEWSW_20010911_040000_The_National.m3u8" },
]

let channel = 0

$(function () {
    $("#volume").hide()

    var dt = new Date();
    let nowTime = dt.getSeconds() + (60 * (dt.getMinutes() + (60 * dt.getHours())));
    $("#tv-player").attr('src', videos[0].url);
    $("#channel").text(videos[0].title)
    $("#tv-player").prop("currentTime", nowTime)

    const interval = setInterval(function () {
        if($("#tv-player").prop("currentTime") >= 86350) {
            $("#tv-player").prop("currentTime", 0);
        }
        $("#time").html(secondsToDhms($("#tv-player").prop("currentTime")))
    }, 1000);
});

$(function () {
    $(document).keypress(function (event) {

        key = String.fromCharCode(event.which);
        mover = 0;

        switch (key) {
            case "+":
                console.log("up")
                changeChannel(1);
                break;
            case "-":
                console.log("down")
                changeChannel(-1);
                break;
            case "l":
                console.log("louder")
                changeVolume(.02);
                break;
            case "s":
                console.log("softer")
                changeVolume(-.02);
                break;
            case " ":
                console.log("toggle")
                changeState("toggle");
                break;
            default:
                mover = 0;
                break;
        }

    });
});

function changeState(state) {
    switch(state) {
        case "toggle":
            var video = $("#tv-player").get(0);
            if ( video.paused ) {
                $("#tv-player").trigger("play")
            } else {
                $("#tv-player").trigger("pause")
            }
        }
}

function changeVolume(inc) {
    cv = parseFloat($("#tv-player").prop("volume").toFixed(2))
    cvpct = Math.round((cv * 100)/2);
    $("#volume").show()
    idt = ""
    if(cvpct + (inc*50) > 0) {
        idt = Array(cvpct).join("|")
    }
    $("#volume-indicator").text(idt);
    $("#volume-count").text(cvpct);
    $("#tv-player").prop("volume", cv + inc);
    vih = setTimeout(function() {
        $('#volume').hide();
    }, 3000); // <-- time in milliseconds
}
function changeChannel(inc) {
    time = $("#tv-player").prop("currentTime")

    topChannel = videos.length - 1

    newChannel = channel + inc

    if (newChannel > topChannel) {
        newChannel = 0
    }

    if (newChannel < 0) {
        newChannel = topChannel
    }

    channel = newChannel

    $("#channel").text(videos[newChannel].title)
    $("#tv-player").attr('src', videos[newChannel].url);
    $("#tv-player")
        .hide()
        .trigger('load')
        .prop("currentTime", time)
        .trigger('play')
        .delay(3000)
        .show();
}

function secondsToDhms(seconds) {
    seconds = Number(seconds);
    var h = Math.floor(seconds % (3600 * 24) / 3600);
    p = "AM"
    if (h >= 12) {
        h = h - 12
        p = "PM"
    }
    if (h == 0) {
        h = 12
    }
    var m = Math.floor(seconds % 3600 / 60);
    var s = Math.floor(seconds % 60);

    return padWithZero(h, 2) + ":" + padWithZero(m, 2) + ":" + padWithZero(s, 2) + " " + p;
}

function padWithZero(num, targetLength) {
    return String(num).padStart(targetLength, '0');
  }
