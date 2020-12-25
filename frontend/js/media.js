
// Media Contol and associated functios

// Audio Control
function muteAllPlayers() {
    $('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        $(this).prop('muted', true);
    });
}

function unmuteAudioPlayers() {
    $("audio:not(.handsoff)").prop('muted', false);
}

function muteAudioPlayers() {
    $("audio:not(.handsoff)").prop('muted', true);
}

function setTimeAllPlayers() {
    $('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        $(this).get(0).currentTime = setPlayerTime(this);
    });
}

// Jump to the right timestamp
function jumpIt(timeString) {
    window.timekeeper.currentTime = hmsToSeconds(timeString)
}

// Playback Control
function pauseAllPlayers() {
    $('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        $(this).get(0).pause();
        // if (playPromise !== undefined) {
        //     playPromise.then(function () {
        //         // Automatic playback started!
        //     }).catch(function (error) {
        //         // Automatic playback failed.
        //         // Show a UI element to let the user manually start playback.
        //     });
        // }
    });
}

function playAllPlayers() {
    $('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        var playPromise = $(this).get(0).play();
        // In browsers that don’t yet support this functionality,
        // playPromise won’t be defined.
        if (playPromise !== undefined) {
            playPromise.then(function () {
                // Automatic playback started!
            }).catch(function (error) {
                // Automatic playback failed.
                // Show a UI element to let the user manually start playback.
            });
        }
    });
}

// Media Functions
function preloadPlayers(data) {
    if (data != undefined || data.length > 0) {
        data.forEach(function (item) {
            if (item.media_type == 'audio') { // just audio files for now
                preloadMediaFile(item.media_type, item.url, item.vidid);
            }
        }
        )
    };
}
function preloadMediaFile(mediaType, url, id) {
    if (!$("#" + id + "_preload").length && (mediaType == "audio" || mediaType == "video")) {
        a = $('<' + mediaType + ' />')
            .attr('src', url)
            .attr('id', id + '_preload')
            .attr('preload', true)
            .attr('autoplay', false)
            .attr('muted', true)
            .css('display', 'none')
            .addClass('handsoff')
            .appendTo('#preloads');
    }
};

// Time Functions
function setPlayerTime(player) {
    var dataItem = window.data.find(data => data.vidid === player.id);
    return window.johng.timestamp() - hmsToSeconds(dataItem.start) + dataItem.jump;
}

function formatTime(date) {
    date = Date.parse(date)
    var hours = date.getHours();
    var minutes = date.getMinutes();
    var ampm = hours >= 12 ? 'pm' : 'am';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    minutes = minutes < 10 ? '0' + minutes : minutes;
    var strTime = hours + ':' + minutes + ' ' + ampm;
    return (strTime)
}

function zeroFill(number, width) {
    width -= number.toString().length;
    if (width > 0) {
        return new Array(width + (/\./.test(number) ? 2 : 1)).join('0') + number;
    }
    return number + ""; // always return a string
}

//Get the Current time in text format
function getTimeText(seconds) {
    var d = new Date(0);
    d.setSeconds(seconds); // specify value for SECONDS here
    var stringDate = (d.getHours() + 6) + ":" + zeroFill(d.getMinutes(), 2) + ":" + zeroFill(d.getSeconds(), 2)

    return stringDate;
}

//convert12Hto24H Convert 12H time format to 24H time format
function convert12Hto24H(stringTimeInput) {
    stringTime = $.trim(stringTimeInput)
    const [time, modifier] = stringTime.split(' ');
    let [hours, minutes, seconds] = time.split(':');
    if (seconds === undefined) {
        seconds = "00";
    }

    if (hours === '12') {
        hours = '00';
    }

    if (modifier.toUpperCase() === 'PM') {
        hours = parseInt(hours, 10) + 12;
    }

    return `${hours}:${minutes}:${seconds}`;
}