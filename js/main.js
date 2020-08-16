// The 9/11RT johng
// A live re-creation of real-time media from September 11, 2001,
// told in by media, photos, audio and other media timestamped and
// replayed in real time. The time starts at September 11, 2001 at
// Midnight Easter Time, and runs to 11:59:59 PM the same day.
//


// Place any jQuery/helper plugins in here.

$(".nav-link").click(function () {
    jumpIt(moment($(this).children().text(), ["h:mm A"]).format("HH:mm:ss"));
});

$("#playButton").on("click", function () {
    $("#timekeeper").trigger('play');
});

$("#pauseButton").on("click", function () {
    $("#timekeeper").trigger('pause');
});

$('.nav-link').on("click", function () {
    pauseAllPlayers();
    jumpIt(convert12Hto24H(this.text));
})

$('.ffrw').on("click", function () {
    var timekeeper = $('#timekeeper').get(0);
    timekeeper.currentTime = timekeeper.currentTime + $(this).data("skip");
});

function overlayOn() {
    document.getElementById("overlay").style.display = "block";
}

function overlayOff() {
    document.getElementById("overlay").style.display = "none";
    document.getElementById("closepopupbutton").style.display = "none";
}

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

function setTimeAllPlayers() {
    $('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        $(this).get(0).currentTime = setPlayerTime(this);
    });
}
function getCurrentTime(timeString) {
    a = (new Date).clearTime().addSeconds(timekeeper.currentTime).toString('h:mm:ss tt');
    return a;
}

function setPlayerTime(player) {
    var dataItem = window.data.find(data => data.vidid === player.id);
    return johng.timestamp() - hmsToSeconds(dataItem.start) + dataItem.jump;
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

function isPlaying(playerId) {
    var player = document.getElementById(playerId);
    return !player.paused && !player.ended && 0 < player.currentTime;
}

function pauseAllPlayers() {
    $('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        promise = $(this).get(0).pause();
    });
}

function playAllPlayers() {
    $('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        $(this).get(0).play();
    });
}

function muteAllPlayers() {
    $('video:not(.handsoff), audio:not(.handsoff), div.embededHTML').each(function () {
        $(this).prop('muted', true);
    });
}

function unmuteAudioPlayers() {
    $("audio:not(.handsoff)").prop('muted', false);
}

function muteAudioPlayers() {
    $("audio:not(.handsoff)").prop('muted', true);
}


function addTimelineListeners() {
    // Attach the media timeline to an HTML5 player
    // The player will control the current 'time' of the sim
    var timekeeper = $('#timekeeper').get(0);
    timekeeper.setAttribute("autoplay", "false");

    // When the timkekeeper is loaded, jump to the start point,
    // load the videos and then pause, ready for play.
    $('#timekeeper').on('loadeddata', function () {
        jumpIt(start);
        $(this).trigger('pause')
        setTimeAllPlayers();
        muteAllPlayers();
        pauseAllPlayers();
    });

    // Events for the main timeline controller
    // When the timeline is seeked, then update the play location of the child video players
    timekeeper.addEventListener('seeked', function () {
        setTimeAllPlayers();
    }, false);

    // When the timeline controller is playing, make sure the child video players are running
    timekeeper.addEventListener('play', function () {
        setTimeAllPlayers();
        playAllPlayers();
    }, false);

    // When the timeline controller is paused, make sure the child video players also pause
    timekeeper.addEventListener('pause', function () {
        setTimeAllPlayers();
        pauseAllPlayers();
    }, false);
}

// Helper function to convert HH:MM:SS to Seconds
function hmsToSeconds(hmsString) {
    var a = hmsString.split(':'); // split it at the colons

    // minutes are worth 60 seconds. Hours are worth 60 minutes.
    var seconds = (+a[0]) * 60 * 60 + (+a[1]) * 60 + (+a[2]);

    return seconds;
}

function getData() {
    var result;
    $.ajax({
        type: 'GET',
        url: getURL(),
        dataType: 'json',
        async: false,
        cache: true,
        success: function (data) {
            result = data;
        }
    });
    // TODO: Add localstorage caching here to prevent multiple calls to the endpoint
    window.data = result;
};

function getNetworks() {
    var result;
    $.ajax({
        type: 'GET',
        url: baseremoteurl + 'networks',
        dataType: 'json',
        async: false,
        cache: true,
        success: function (networks) {
            result = networks;
        }
    });
    // TODO: Add localstorage caching here to prevent multiple calls to the endpoint
    window.networks = result;
};

function updateNetworks() {
    $.each(window.networks, function (i, value) {
        $('#network').append($('<option>').text(value).attr('value', value));
    });
}
function updateData() {
    getNetworks();
    getData();
    updateNetworks();

    johng.all_data(window.data);
    preloadPlayers(window.data);
    $('#timekeeper').trigger('pause')
}

function preloadPlayers(data) {
    if (data === undefined || data.length == 0) {
        data.forEach(function (item) {
            if (item.media_type == 'audio') {
                preloadAudioFile(item.url);
            }
        }
    )};
}

function preloadAudioFile(url) {
    a = $('<audio />')
        .attr('src', url)
        .attr('preload', true)
        .attr('autoplay', false)
        .attr('muted', true)
        .appendTo('#preloads')
        .css('display', 'none')
        .addClass('handsoff');
};

// Adds the base API URL and any URL filters and returns a full URL for AJAX calls
function getURL() {
    console.log(baseremoteurl + "?" + $("#filters").serialize());
    return baseremoteurl + "?" + $("#filters").serialize();
}

function removeItems(currentItemsList, activeItemsList) {

    // Show which players should be removed
    let removePlayers = currentItemsList.filter(x => !activeItemsList.includes(x));
    // And remove them
    if (Array.isArray(removePlayers)) {
        // We have some players that are no longer live and should be destroyed.
        removePlayers.forEach(
            function (playerId) {
                if (playerId) {
                    document.getElementById(playerId + "_div").remove();
                }
            })
    }
};

baseremoteurl = "https://civil-clarity-280121.ue.r.appspot.com/media/";
start = "08:49:35";
getData();
getNetworks();
updateNetworks();

window.data.forEach(function (item) {
    if (item.media_type == 'audio') {
        preloadAudioFile(item.url);
    }
}
)
// Jump to the right timestamp
function jumpIt(timeString) {
    timekeeper.currentTime = hmsToSeconds(timeString)
}

function getCurrentTime(timeString) {
    a = (new Date).clearTime().addSeconds(timekeeper.currentTime).toString('h:mm:ss tt');
    return a;
}

function addItems(currentItemsList, activeItemsList) {
    // Show which players are not active but should be added
    let addPlayers = activeItemsList.filter(x => !currentItemsList.includes(x));

    // And add them
    if (Array.isArray(addPlayers)) {
        // Ok, so addPlayers is an actual Array, so we can loop over it
        addPlayers.forEach(
            function (playerId) {
                // Does a player window with the same ID already exist?
                var doesPlayerExist = document.getElementById(playerId);

                if (!doesPlayerExist) {
                    // Grab the video data item because we need it
                    var mediaItem = data.find(data => data.vidid === playerId);

                    // If not, then let's create a container...
                    var newMediaItemContainer = $("<div/>")
                        .attr("id", playerId + "_div")

                        switch (mediaItem.media_type) {

                        case 'video':
                            var newMediaItem = $("<video />", {
                                'id': playerId,
                                'src': mediaItem.url,
                                'type': mediaItem.media_type + "/" + mediaItem.format,
                                'controls': false,
                                'muted': true,
                                'preload': 'auto',
                                'class': '',
                            })
                            .on("ended", function () {
                                $("#" + playerId + "_div").remove();
                            });

                            var newMediaItemTitle = $("<h2 />")
                                .attr("id", playerId + '_title')
                                .text(mediaItem.source);

                            break;

                        case 'audio':
                            var newMediaItem = $('<audio />', {
                                'id': playerId,
                                'src': mediaItem.url,
                                'type': mediaItem.media_type + '/' + mediaItem.format,
                                'controls': true,
                                'autoplay': false,
                                'media_volume': mediaItem.volume,
                                'class': '',
                            })
                            .on("ended", function () {
                                $("#" + playerId + "_div").remove();
                            });


                            var newMediaItemTitle = $('<h2 />')
                                .attr("id", playerId + '_title')
                                .text(mediaItem.source + ' - ' + mediaItem.title);

                            break;

                        case 'html':
                            var newMediaItem = $('<div />', {
                                'id': playerId
                            })
                                .addClass('embededHTML')
                                .html(mediaItem.content);
                                newMediaItem.prepend($('<img />',  {
                                    'src': mediaItem.image,
                                    'style': 'float: right; width: 35%'
                                }))
                            var newMediaItemTitle = $('<h6 />')
                                .text(formatTime(mediaItem.start_date) + ' - ' + mediaItem.title);

                            break;

                        default:
                            var newMediaItem = $('<div />', {
                                'id': playerId
                            })
                                .addClass('embededHTML')
                                .text(mediaItem.full_title)

                            var newMediaItemTitle = $()
                                .text(mediaItem.source);

                            break;
                    };



                    // Add video object and title we just created to DOM
                    newMediaItemTitle.appendTo($(newMediaItemContainer));
                    newMediaItem.appendTo($(newMediaItemContainer));
                    newMediaItemContainer.prependTo("#" + mediaItem.media_type + "s");
                    newMediaItem[0].currentTime = johng.timestamp() - hmsToSeconds(mediaItem.start) + mediaItem.jump;
                    newMediaItem.prop("volume", $(newMediaItem).attr('media_volume'));
                    newMediaItem.prop("muted", $(newMediaItem).attr('muted'));

                    if (mediaItem.media_type == 'html') {
                        newMediaItem.readmore({
                            collapsedHeight: 0,
                            speed: 75,
                            lessLink: '<button class="btn mr-2 mb-2 btn-primary" type="button"><span class="btn-text"><a href="#">Read Less</a></span></button>',
                            moreLink: '<button class="btn mr-2 mb-2 btn-primary" type="button"><span class="btn-text"><a href="#">Read More</a></span></button>',
                            blockCSS: 'display: block; float: right;'
                        })
                    }

                    // TODO: We're not doing anything with the promise right now, but will need to later
                    playPromise = newMediaItem.trigger('play').promise();

                    // When mousing over a player, unmute it so we can hear.
                    $(newMediaItemContainer).mouseover(function () {
                        if ($('#' + playerId + '_div').hasClass("highlight") && (mediaItem.media_type == 'video')) {
                            $('#' + playerId).prop('muted', false);
                        }
                    });

                    // When mousing out of a player, mute it again,
                    // unless it is our main video, in which case don't mute.
                    $(newMediaItemContainer).mouseout(function () {
                        if ($('#' + playerId + '_div').hasClass("highlight") && (mediaItem.media_type == 'video')) {
                            $('#' + playerId).prop('muted', false);
                        }
                    });

                    // When clicking a player, make it the main video player,
                    $(newMediaItemContainer).click(function () {
                        if ((mediaItem.media_type == 'video')) {
                            $('#' + mediaItem.media_type + 'playermain').children().prependTo('#' + mediaItem.media_type + 's');
                            $('#' + playerId).prop('muted', $('#' + playerId).attr('muted'));
                            if ($('#' + playerId + '_div').hasClass("highlight")) {
                                $('div').removeClass("highlight");
                            } else {
                                $('div').removeClass("highlight");
                                $('#' + mediaItem.media_type + 's').find(mediaItem.media_type).prop('muted', true);
                                $('#' + playerId + '_div').prependTo('#' + mediaItem.media_type + 'playermain')
                                    .addClass("highlight");
                                $('#' + playerId).prop('muted', false);
                            }}
                        return false;
                    });

                }
            }
        )
    }
}

// Boilerplate code to load our framework, memento.js
var johng = memento();

// Attach our memento object to our timekeeper audio player
johng.node(timekeeper);

// This function loads the data into johng
johng.all_data(window.data);

// Initialize the tracker
johng();

// Every time the media player's time changes, this function weill be called
// This is our main running function
johng.tick(true, function (activeItems, timestamp) {

    // Set some variables
    let currentItemsList = [], activeItemsList = [], currentItems = [];
    $('.timeText').text(getCurrentTime());
    // We slice the currentItems list so we can an Array instead of an HTMLCollection
    currentItems = Array.prototype.slice.call(document.querySelectorAll("div.embededHTML, video:not(.handsoff), audio:not(.handsoff)"));

    // The activeItems is passed in to the function each time it is run
    activeItems.forEach(function (item) {
        activeItemsList.push(item.vidid);
    })

    // Current items are those currently on the page
    currentItems.forEach(function (item) {
        currentItemsList.push(item.id);
    })

    // check for media settings
    if ($('#mute_all_audio').is(':checked')) {
        muteAudioPlayers();
    } else {
        unmuteAudioPlayers();
    }

    addItems(currentItemsList, activeItemsList);
    removeItems(currentItemsList, activeItemsList);

});

function overlayOn() {
    document.getElementById("overlay").style.display = "block";
}

function overlayOff() {
    document.getElementById("overlay").style.display = "none";
    document.getElementById("closepopupbutton").style.display = "none";
}
// Setup things when the document is ready
$(document).ready(function () {
    // If updating form fields, add their changes to the URL
    $("input[type='radio']").on("click", updateData);
    $("select").on("change", updateData);

    addTimelineListeners();
    window.setInterval(function () {
        if (!isPlaying('timekeeper')) {
            pauseAllPlayers()
        };
    }, 1000);
    $(function () {
        $('[data-toggle="tooltip"]').tooltip()
    })
    //overlayOn();
    //$('#aol').trigger("play");
    $('#aol').on("ended", function(){
        overlayOff();
    })

    $('#closepopup').on('click', function(){
        overlayOff();
        this.display('none');
    })

});
