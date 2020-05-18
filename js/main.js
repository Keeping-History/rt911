// The 9/11RT johng
// A live re-creation of real-time media from September 11, 2001,
// told in by media, photos, audio and other media timestamped and
// replayed in real time. The time starts at September 11, 2001 at
// Midnight Easter Time, and runs to 11:59:59 PM the same day.
//

baseremoteurl = "http://localhost:8000/media/";
start = "08:33:30";

function addTimelineListeners() {

    data = get_data();
    // Attach the media timeline to an HTML5 player
    // The player will control the current 'time' of the sim
    var timekeeper = $('#timekeeper').get(0);
    timekeeper.setAttribute("autoplay", "false");

    // When the timkekeeper is loaded, jump to the start point,
    // load the videos and then pause, ready for play.
    $('#timekeeper').on('canplaythrough', function () {
        jumpIt(start);
    });

    // Events for the main timeline controller
    // When the timeline is seeked, then update the play location of the child video players
    timekeeper.addEventListener('seeked', function() {
        var players = $("video, audio:not(#timekeeper");
        for (let player of players) {
            var dataItem = data.find(data => data.vidid === player.id);
            $(player).on('loadeddata', function () {
                set_player_time(dataItem);
            })
        }
    }, false);

    // When the timeline controller is playing, make sure the child video players are running
    timekeeper.addEventListener('play', function() {
        var players = document.querySelectorAll("video, audio:not(#timekeeper");
        for (let player of players) {
            $('#' + player.id).get(0).play()
        }
    }, false);

    // When the timeline controller is paused, make sure the child video players also pause
    timekeeper.addEventListener('pause', function() {
        var players = document.querySelectorAll("video, audio:not(#timekeeper");
        for (let player of players) {
            player.pause();
        }
    }, false);
}

function removeItems(activePlayersList, activeVideosList) {
    // Show which players should be removed
    let removePlayers = activePlayersList.filter(x => !activeVideosList.includes(x));

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

function addItems(activePlayersList, activeVideosList) {
    // Show which players are not active but should be added
    let addPlayers = activeVideosList.filter(x => !activePlayersList.includes(x));

    // And add them
    if (Array.isArray(addPlayers)) {
        // Ok, so addPlayers is an actual Array, so we can loop over it
        addPlayers.forEach(
            function (playerId) {

                // Does a player window with the same ID already exist?
                var doesPlayerExist = document.getElementById(playerId);

                if (!doesPlayerExist) {
                    // Grab the video data item because we need it
                    var dataItem = data.find(data => data.vidid === playerId);

                    // If not, then let's create a container...
                    var newPlayerContainer = $('<div/>')
                        .attr("id", playerId + '_div')

                    switch (dataItem.media_type) {
                        case 'video':
                            var mute_element = true;
                            var show_controls = false;
                            break;
                        case 'audio':
                            mute_element = false;
                            show_controls = true;
                            break;
                        default:
                            var mute_element = true;
                            var show_controls = false;
                    }

                    var newPlayer = $('<' + dataItem.media_type + ' />', {
                        id: playerId,
                        src: dataItem.url,
                        type: dataItem.media_type + '/' + dataItem.format,
                        controls: show_controls,
                        muted: mute_element,
                        autoplay: true
                    });

                    var newPlayerTitle = $('<h2 />')
                        .attr("id", playerId + '_title')
                        .text(dataItem.source);

                    // Add video object and title we just created to DOM
                    newPlayerTitle.appendTo($(newPlayerContainer));
                    newPlayer.appendTo($(newPlayerContainer));
                    newPlayerContainer.appendTo("#" + dataItem.media_type + "s");

                    // When mousing over a player, unmute it so we can hear.
                    $(newPlayerContainer).mouseover(function () {
                        $('#' + playerId).prop('muted', false);
                    });

                    // When mousing out of a player, mute it again,
                    // unless it is our main video, in which case don't mute.
                    $(newPlayerContainer).mouseout(function () {
                        if ($('#' + playerId + '_div').hasClass("highlight") && (dataItem.media_type == 'video')) {
                            $('#' + playerId).prop('muted', mute_element);
                        } else if (dataItem.media_type == 'audio') {
                            $('#' + playerId).prop('muted', mute_element);
                        }
                        else {
                            $('#' + playerId).prop('muted', true);
                        }
                    });

                    // When clicking a player, make it the main video player,
                    $(newPlayerContainer).click(function () {

                        $('#videoplayermain').children().prependTo("#" + dataItem.media_type + "s");

                        if ($('#' + playerId + '_div').hasClass("highlight")) {
                            $('#' + playerId + '_div').removeClass("highlight");
                            document.getElementById(playerId).muted = true;
                        } else {
                            var container = document.querySelector("#" + dataItem.media_type + "s");
                            matches = container.querySelectorAll('div.highlight')

                            matches.forEach(function (item) {
                                item.classList.remove("highlight");
                            });

                            $('#' + playerId + '_div').addClass("highlight");
                            $('#' + playerId).prop('muted', false);
                            $('#videoplayermain').append($('#' + playerId + '_div').detach());
                        }
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

// This function actually gets the data from an AJAX connection, returns it as JSON and loads into johng
johng.all_data(get_data());

// Initialize the tracker
johng();

johng.tick(true, function(activeVideos, timestamp) {

    // Every time the media player's time changes, this function weill be called

    // Set some variables
    let activePlayersList = [];
    let activeVideosList = [];

    // We slice the activePlayers list so we can an Array instead of an HTMLCollection
    activePlayers = Array.prototype.slice.call(document.querySelectorAll('video, audio:not(#timekeeper)'));

    // The activeVideos is passed in to the function each time it is run
    if (Array.isArray(activeVideos)) {
        activeVideos.forEach(function (thisVideo) {
            activeVideosList.push(thisVideo.vidid);
        })
    }

    if (Array.isArray(activePlayers)) {
        activePlayers.forEach(function (thisPlayer) {
            activePlayersList.push(thisPlayer.id);
        })
    }

    addItems(activePlayersList, activeVideosList);
    removeItems(activePlayersList, activeVideosList);
});

// Helper function to convert HH:MM:SS to Seconds
function hmsToSeconds(str) {
    var p = str.split(':'),
        s = 0,
        m = 1;
    while (p.length > 0) {
        s += m * parseInt(p.pop(), 10);
        m *= 60;
    }
    return s;
}

// Jump to the right timestamp
function jumpIt(str) {
    timekeeper.currentTime = hmsToSeconds(str)
}

// Adds the base API URL and any URL filters and returns a full URL for AJAX calls
function getURL() {
    return baseremoteurl + "?" + $("#filters").serialize();
}

// This function actually gets the data from an AJAX connection and returns it as JSON
function get_data() {
    var result;
    $.ajax({
        type: 'GET',
        url: getURL(),
        dataType: 'json',
        async: false,
        success: function (data) {
            result = data;
        }
    });
    return result;
};

// Setup things when the document is ready
$(document).ready(function () {
    // If updating form fields, add their changes to the URL
    // $("input[type='checkbox'], input[type='radio']").on("click", update_data);
    // $("select").on("change", update_data);

    addTimelineListeners();
    window.setInterval(function () {
        if (!isPlaying('timekeeper')) {
            pause_all_players()
        };
    }, 1000);
});
