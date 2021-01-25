// Playback Control
function pauseAllPlayers() {
    jQuery('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        jQuery(this).get(0).pause();
    });
}

function playAllPlayers() {
    jQuery('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        jQuery(this).get(0).play();
    });
}

// Media Functions
function preloadPlayers(data) {
    if (data != undefined || data.length > 0) {
        data.forEach(function (item) {
            if (item.media_type == 'audio') { // just audio files for now
                preloadMediaFile(item.media_type, item.url, item.vidid);
            }
        });
    }
}
function preloadMediaFile(mediaType, url, id) {
    if (!jQuery("#" + id + "_preload").length && (mediaType == "audio")) {
        a = jQuery('<' + mediaType + ' />')
            .attr('src', url)
            .attr('id', id + '_preload')
            .attr('preload', true)
            .attr('autoplay', false)
            .attr('muted', true)
            .css('display', 'none')
            .addClass('handsoff')
            .appendTo('#preloads');
    }
}

// Time Functions
function setPlayerTime(player) {
    jsonData = getData();
    dataItem = jsonData.find(jsonData => jsonData.vidid === player.id);
    return johng.timestamp() - dataItem.start + dataItem.jump;
}

//Get the Current time in text format
function secondsToTimeFormatted(seconds) {
    var d = new Date(0);
    d.setSeconds(seconds);
    d.setHours(d.getHours() + 6); // Eastern Time Zone adjustment
    return dateFormatter(d) + " ET";
}

function dateFormatter(d) {
    var hours = d.getHours();
    var minutes = d.getMinutes();
    var seconds = d.getSeconds();
    var ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12; // the hour '0' should be '12'
    minutes = minutes < 10 ? '0' + minutes : minutes;
    seconds = seconds < 10 ? '0' + seconds : seconds;
    var strTime = hours + ':' + minutes + ":" + seconds + " " + ampm;

    return strTime;

}

//convert12Hto24H Convert 12H time format to 24H time format
function convert12Hto24H(stringTimeInput) {
    stringTime = $.trim(stringTimeInput);
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

var baseRemoteURL = "http://api.911realtime.org/";

// Adds the base API URL and any URL filters and returns a full URL for AJAX calls
function getURL() {
    var d = new Date();
    return window.baseRemoteURL + "?tm=" + d.getTime() + "&" + jQuery("#filters :input[value!='all']").serialize();
}

function muteAudioPlayers() {
    //TODO: placeholder, i lost this code somwhere
}

// Grabs the json via ajax
function getData() {
    if (typeof window.data !== 'undefined') {
        return window.data;
    } else {
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
        return result;
    }
}

// Grabs the available sources/networks via ajax
function getNetworks() {
    var result;
    $.ajax({
        type: 'GET',
        url: window.baseRemoteURL + 'networks',
        dataType: 'json',
        async: false,
        cache: true,
        success: function (networks) {
            result = networks;
        }
    });
    // TODO: Add localstorage caching here to prevent multiple calls to the endpoint
    return result;
}

function hmsToSeconds(hmsString) {
    var a = hmsString.split(':'); // split it at the colons

    // minutes are worth 60 seconds. Hours are worth 60 minutes.
    var seconds = (+a[0]) * 60 * 60 + (+a[1]) * 60 + (+a[2]);

    return seconds;
}

function isPlaying(playerId) {
    var player = document.getElementById(playerId);
    return !player.paused && !player.ended && 0 < player.currentTime;
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
                    jQuery('#' + playerId + '_div').remove();
                    jQuery('#' + playerId + '_preload').remove();
                }
            });
    }
}

function updateData() {
    networks = getNetworks();
    updateNetworks(networks);
    data = getData();
    window.johng.all_data(data);
    jQuery('#timekeeper').trigger('pause');
}

function addItems(currentItemsList, activeItemsList) {
    // Show which players are not active but should be added
    let addMediaItems = activeItemsList.filter(x => !currentItemsList.includes(x));

    // And add them
    if (Array.isArray(addMediaItems)) {
        // Ok, so addMediaItems is an actual Array, so we can loop over it
        addMediaItems.forEach(
            function (playerId) {
                // Does a player window with the same ID already exist?
                var doesPlayerExist = document.getElementById(playerId);

                if (!doesPlayerExist) {
                    // Grab the video data item because we need it
                    var mediaItem = data.find(data => data.vidid === playerId);

                    switch (mediaItem.media_type) {
                        case 'video':
                            jQuery("#videos").append(create_video(playerId, mediaItem));
                            break;

                        case 'audio':
                            jQuery("#audios").append(create_audio(playerId, mediaItem));
                            break;

                        case 'html':
                            jQuery("#htmls").append(create_html(playerId, mediaItem));
                            break;

                        case 'modal':
                            if (jQuery.inArray(mediaItem.vidid, window.globalModals) === -1) {
                                jQuery('#modal-title').text(mediaItem.source);
                                jQuery('#modal-time').text(mediaItem.start);

                                if (mediaItem.image != "") {
                                    jQuery("#modal-image").attr("src", mediaItem.image);
                                    jQuery("#modal-image").attr("alt", mediaItem.image_caption);
                                    if (mediaItem.image_caption != "") {
                                        jQuery("#modal-image-caption").html(mediaItem.image_caption);
                                    }
                                }

                                jQuery('#modal-fulltitle').text(mediaItem.title);
                                jQuery('#modal-content').html(mediaItem.content);
                                jQuery('#modalModal').modal({
                                    backdrop: false,
                                    show: true,
                                    showClose: false,
                                    closeExisting: false,
                                    fadeDuration: 100
                                })
                                window.globalModals.push(mediaItem.vidid);
                                jQuery("#timekeeper").trigger('pause');
                            }
                            break;
                    };

                    if (mediaItem.media_type != 'modal') {
                        // Add video object and title we just created to DOM
                        jQuery("#" + playerId + "_div").prependTo("#" + mediaItem.media_type + "s");
                    };

                    if (mediaItem.media_type == 'audio' || mediaItem.media_type == 'video') {
                        jQuery("#" + playerId).prop("volume", jQuery(jQuery("#" + playerId)).attr('media_volume'));
                        jQuery("#" + playerId).prop("muted", jQuery(jQuery("#" + playerId)).attr('muted'));
                        jQuery("#" + playerId).currentTime = window.johng.timestamp() - mediaItem.start + mediaItem.jump;

                        // TODO: We're not doing anything with the promise right now, but will need to later
                        jQuery("#" + playerId).trigger('load');
                    }

                    if (mediaItem.media_type == 'video') {

                        jQuery("#" + playerId).on("ended", function () {
                            jQuery("#" + playerId + "_div").empty().remove();
                        });

                        // When mousing over a player, unmute it so we can hear.
                        jQuery(jQuery("#" + playerId + "_div")).mouseover(function () {
                            if (jQuery('#' + playerId + '_div').hasClass("highlight") && (mediaItem.media_type == 'video')) {
                                jQuery('#' + playerId).prop('muted', false);
                            }
                        });

                        if (mediaItem.format == 'm3u8') {
                            if (Hls.isSupported()) {
                                var video = document.getElementById(playerId);
                                var hls = new Hls();
                                // bind them together
                                hls.attachMedia(video);
                                hls.on(Hls.Events.MEDIA_ATTACHED, function () {
                                    hls.loadSource(mediaItem.url);
                                });
                            }
                        }
                        // When mousing out of a player, mute it again,
                        // unless it is our main video, in which case don't mute.
                        jQuery(jQuery("#" + playerId + "_div")).mouseout(function () {
                            if (jQuery('#' + playerId + '_div').hasClass("highlight")) {
                                jQuery('#' + playerId).prop('muted', false);
                            }
                        });

                        // When clicking a player, make it the main player,
                        jQuery("#" + playerId + "_div").click(function () {
                            jQuery('#' + mediaItem.media_type + 'playermain').children().prependTo('#' + mediaItem.media_type + 's');
                            jQuery('#' + playerId).prop('muted', jQuery('#' + playerId).attr('muted'));
                            if (jQuery('#' + playerId + '_div').hasClass("highlight")) {
                                jQuery('div').removeClass("highlight");
                            } else {
                                jQuery('div').removeClass("highlight");
                                jQuery('#' + mediaItem.media_type + 's').find(mediaItem.media_type).prop('muted', true);
                                jQuery('#' + playerId + '_div').prependTo('#' + mediaItem.media_type + 'playermain')
                                    .addClass("highlight");
                                jQuery('#' + playerId).prop('muted', false);
                            }
                            return false;
                        });
                    }
                }
            });
    }

    const audioPlayers = Plyr.setup('.plyr-audio', { controls: ['current-time', 'duration', 'mute'] });
    //const videoPlayers = Plyr.setup('.plyr-video', { controls: [''], clickToPlay: false });
    setReadMores();

}

function create_audio(playerId, mediaItem) {
    var audioItem = {
        PlayerID: playerId,
        AudioURL: mediaItem.url,
        Volume: mediaItem.volume,
        Type: mediaItem.type,
        Title: mediaItem.source + ' - ' + mediaItem.title
    };

    var template = document.getElementById('audio_player_template').innerHTML;
    return $.parseHTML(
        $.trim(
            Mustache.render(
                template,
                audioItem
            )
        )
    );
}

function create_html(playerId, mediaItem) {
    var htmlItem = {
        ItemID: playerId,
        Time: dateFormatter(Date.parse(mediaItem.start_date)),
        Title: mediaItem.title,
        ImageURL: mediaItem.image,
        Content: mediaItem.content
    };

    var template = document.getElementById('html_item_template').innerHTML;
    return $.parseHTML(
        $.trim(
            Mustache.render(
                template,
                htmlItem
            )
        )
    );
}

function create_video(playerId, mediaItem) {
    if (mediaItem.format == 'm3u8') {
        mediaType = "application/x-mpegURL";

    } else if (mediaItem.format == "mpd") {
        mediaType = "application/dash+xml";
    } else (
        mediaType = mediaItem.media_type + "/" + mediaItem.format
    );

    var videoItem = {
        PlayerID: playerId,
        VideoURL: mediaItem.url,
        Type: mediaItem.type,
        Source: mediaItem.source
    };

    var template = document.getElementById('video_item_template').innerHTML;
    return $.parseHTML(
        $.trim(
            Mustache.render(
                template,
                videoItem
            )
        )
    );

}

function isMediaReady() {
    current_data = johng.data();
    current_data.forEach(element => {
        if (element.media_type == 'video') {
            console.log('found video: ', element);
            jQuery("#" + element.vidid).on('canplay', function () {
                console.log('canplay: ', element);
            });
        }
    });
}

function isPlaying(playerId) {
    var player = document.getElementById(playerId);
    return !player.paused && !player.ended && 0 < player.currentTime;
}

function moveTime(increment) {
    pauseAllPlayers();
    timekeeper.currentTime = timekeeper.currentTime + increment;
    setTimeAllPlayers();
    playAllPlayers();
}

function setReadMores() {
    // jQuery("#htmls div div").readmore({
    //     embedCSS: false,
    //     collapsedHeight: 0,
    //     speed: 75,
    //     lessLink: '<button class="command_button" type="button"><span class="btn-text"><a href="#">Read Less</a></span></button>',
    //     moreLink: '<button class="command_button" type="button"><span class="btn-text"><a href="#">Read More</a></span></button>',
    //     blockCSS: 'display: inline-block; float: right;'
    // });
}
// Jump to the right timestamp
function jumpIt(timeString) {
    timekeeper.currentTime = hmsToSeconds(timeString);
    setTimeAllPlayers();
}

function addTimekeeperListeners() {
    // Attach the media timeline to an HTML5 player
    // The player will control the current 'time' of the sim
    timekeeper.setAttribute("autoplay", "false");
    startTime = "08:46:00";

    jumpIt(startTime);
    muteAudioPlayers();
    pauseAllPlayers();
    setTimeAllPlayers();

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

function updateNetworks() {
    networks = getNetworks();
    networks.forEach(function (item) {
        jQuery('#network').append(jQuery('<option>').text(item).attr('value', item));
    });
}

function updateData() {
    updateNetworks(getNetworks());
    window.johng.all_data(getData());
    jQuery('#timekeeper').trigger('pause');
}


// The 9/11RT johng
// A live re-creation of real-time media from September 11, 2001,
// told in by media, photos, audio and other media timestamped and
// replayed in real time. The time starts at September 11, 2001 at
// Midnight Eastern Time, and runs to 11:59:59 PM the same day.
//

// Setup things when the document is ready
jQuery(function () {

    jQuery('.close-modal-main-button').click(function (event) {
        event.preventDefault();
        jQuery("#chime").trigger('play');
        jQuery("#bootScreen").fadeOut(1000);
        $.modal.close();
    });

    jQuery(".close-modal-button").click(function () {
        $.modal.close();
        jQuery("#timekeeper").trigger('play');
    });

    jQuery('.close-modal-command').click(function (event) {
        event.preventDefault();
        $.modal.close();
        jQuery("#timekeeper").trigger('play');
    });

    jQuery("#playButton").on("click", function () {
        jQuery("#timekeeper").trigger('play');
        playAllPlayers();
    });

    jQuery("#pauseButton").on("click", function () {
        jQuery("#timekeeper").trigger('pause');
        //pauseAllPlayers();
        //setTimeAllPlayers();
    });

    jQuery('.time-marker').on("click", function () {
        pauseAllPlayers();
        jumpIt(convert12Hto24H(this.text));

    });

    jQuery('.ffrw').on("click", function () {
        moveTime(parseInt(jQuery(this).data("skip")));
    });

    jQuery('#mute_all_audio').click(function () {
        if (jQuery(this).is(':checked')) {
            muteAudioPlayers();
            jQuery('#radio_mute_icon').attr('src', 'https://win98icons.alexmeub.com/icons/png/loudspeaker_muted-0.png');
        } else {
            //unmuteAudioPlayers();
            jQuery('#radio_mute_icon').attr('src', 'https://win98icons.alexmeub.com/icons/png/loudspeaker_rays-0.png');
        }
    });

    // If updating form fields, add their changes to the URL
    jQuery("#filters input").on("click", updateData);
    jQuery("select").on("change", updateData);

    // Make sure the child players are always paused when the timeline player is also paused
    window.setInterval(function () {
        if (!isPlaying('timekeeper')) {
            pauseAllPlayers();
        }
    }, 1000);

});



// Media Contol and associated functios

// Audio Control
function muteAllPlayers() {
    jQuery('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        jQuery(this).prop('muted', true);
    });
}

function unmuteAudioPlayers() {
    jQuery("audio:not(.handsoff)").prop('muted', false);
}

function muteAudioPlayers() {
    jQuery("audio:not(.handsoff)").prop('muted', true);
}

function setTimeAllPlayers() {
    jQuery('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        jQuery(this).get(0).currentTime = setPlayerTime(this);
        jQuery(this).get(0).play();

    });
}


if (Hls.isSupported()) {
    console.log('hls is supported!');
}


var johng = memento();
// select audio node
var timekeeper = document.getElementById('timekeeper');

// bind audio to memento object
johng.node(timekeeper);

// Add listeners so that when our main media player is moved others do the same
//addTimekeeperListeners();


globalModals = [];

// This function loads the data into johng
var data = getData();
window.johng.all_data(data);

//muteAudioPlayers();
//pauseAllPlayers();

// Every time the media player's time changes, this function weill be called
// This is our main running function
johng.tick(true, function (activeItems, timestamp, node) {
    var plusSixtySeconds = johng.data(timestamp + 60);
    if (Array.isArray(plusSixtySeconds)) {
        plusSixtySeconds.forEach(function (item) {
            if (item.media_type == 'audio') { // just audio players for now
                preloadMediaFile(item.media_type, item.url, item.vidid);
            }
        });
    }

    // Set some variables
    var current_data = johng.data();

    let currentItemsList = [], activeItemsList = [], currentItems = [];

    // We slice the currentItems list so we can an Array instead of an HTMLCollection
    currentItems = Array.prototype.slice.call(document.querySelectorAll("div.htmlitem, video:not(.handsoff), audio:not(.handsoff)"));

    // The activeItems is passed in to the function each time it is run
    if (Array.isArray(activeItems)) {
        activeItems.forEach(function (item) {
            activeItemsList.push(item.vidid);
        });
    }

    // Current items are those currently on the page
    if (Array.isArray(currentItems)) {
        currentItems.forEach(function (item) {
            currentItemsList.push(item.id);
        });
    }

    addItems(currentItemsList, activeItemsList);
    removeItems(currentItemsList, activeItemsList);

    // Set the "clock" onscreen to the curent time
    jQuery('.timeText').text(secondsToTimeFormatted(timekeeper.currentTime));

});

// Initialize the tracker
johng();

jumpIt("08:35:00");

//Add custom UI function hooks here
jQuery(function () {
    jQuery("#menu-play").click(function () {
        jQuery("#timekeeper").trigger('play');
    });

    jQuery("#menu-pause").click(function () {
        jQuery("#timekeeper").trigger('pause');
        setTimeAllPlayers();
    });

    jQuery("#jumpItButton").click(function () {
        pauseAllPlayers();
        jumpHour = jQuery("#jumpItHour").val();
        jumpMinute = jQuery("#jumpItMinute").val();
        jumpSecond = jQuery("#jumpItSecond").val();
        if (jumpHour == "") {
            jumpHour = "00";
        }
        if (jumpMinute == "") {
            jumpMinute = "00";
        }
        if (jumpSecond == "") {
            jumpSecond = "00";
        }

        jQuery("#jumpItHour").val(jumpHour);
        jQuery("#jumpItMinute").val(jumpMinute);
        jQuery("#jumpItSecond").val(jumpSecond);

        jumpIt(jumpHour + ":" + jumpMinute + ":" + jumpSecond);
        playAllPlayers();
    });


});
