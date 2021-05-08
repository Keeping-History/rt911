// The 9/11RT johng
// A live re-creation of real-time media from September 11, 2001,
// told in by media, photos, audio and other media timestamped and
// replayed in real time. The time starts at September 11, 2001 at
// Midnight Eastern Time, and runs to 11:59:59 PM the same day.
//

// Global Vars
var baseRemoteURL = "https://api.911realtime.org/";
var timeZone = { plus: 6, pretty: "ET" }
var globalModals = [];
var timeDrift = 5 // don't change the current video's time unless it is this many seconds out of sync
var playoverDrift = 1 // determines how long a media item will play afer it's supposed to be removed, in case it didnt' play all the way through
var playerSync = 2 // determines how quickly after the counter is stopped should audios and videos be checked to stop as well

// Preload data to improve performance
var networkListCache = ["WORLDNET", "WETA", "MCM", "WJLA", "WTTG", "WUSA", "WRC", "NHK", "TCN", "AZT", "GLVSN", "NEWSW", "WSBK", "CNN", "BET", "IRAQ", "BBC", "NTV", "History Commons", "CCTV3", "NEADS/NORAD", "AA11", "atc", "Rutgers", "FLASH", "ANT1", "MSNBC", "PSC"];
var dataCache = [];

// Caching and preload Functions
function preloadPlayers(data) {
    if (data != undefined || data.length > 0) {
        data.forEach(function (item) {
            preloadMediaFile(item.media_type, item.url, item.vidid);
        });
    }
}

function preloadMediaFile(mediaType, url, id) {
    if (!jQuery("#" + id + "_preload").length) {
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

// Playback Control
function pauseAllPlayers() {
    jQuery('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        jQuery(this).get(0).pause();
    });
}

function playAllPlayers() {
    jQuery('video:not(.handsoff), audio:not(.handsoff)').each(function () { 
        if(jQuery(this).get(0).paused){
            jQuery(this).get(0).play();
        }
    });
}

function setTimeAllPlayers() {
    jQuery('video:not(.handsoff), audio:not(.handsoff)').each(function () {
        if (Math.abs(getPlayerTime(this.id) - jQuery(this).get(0).currentTime) > timeDrift) {
            jQuery(this).get(0).currentTime = getPlayerTime(this.id);
        }
    });
}

function setTimePlayer(playerId) {
    video = jQuery("#" + playerId).get(0)
    video.currentTime = getPlayerTime(playerId);
}


// Time Functions
function getPlayerTime(playerId) {
    dataItem = johng.all().find(jsonData => jsonData.vidid === playerId);
    return johng.current() - dataItem.start + dataItem.jump;
}

//Get the Current time in text format
function secondsToTimeFormatted(seconds) {
    var d = new Date(0);
    d.setSeconds(seconds);
    d.setHours(d.getHours() + window.timeZone.plus); // Eastern Time Zone adjustment
    return dateFormatter(d) + " " + window.timeZone.pretty;
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
    return hours + ':' + minutes + ":" + seconds + " " + ampm;
}

// Adds the base API URL and any URL filters and returns a full URL for AJAX calls
function getAPIURL() {
    var d = new Date();
    return window.baseRemoteURL + "?tm=" + d.getTime() + "&" + jQuery("#filters :input[value!='all']").serialize();
}

// Grabs the json via ajax
function getData() {
    if (dataCache.length > 0) {
        return dataCache;
    } else {
        $.ajax({
            type: 'GET',
            url: getAPIURL(),
            dataType: 'json',
            async: false,
            cache: true,
            success: function (data) {
                window.dataCache = data;
            }
        });
        return dataCache;
    }
}

// Grabs the json via ajax
function updateNetworks() {
    if (networkListCache.length > 0) {
        networkListCache.forEach(function (item) {
            jQuery('#network').append(jQuery('<option>').text(item).attr('value', item));
        });
    } else {
        $.ajax({
            type: 'GET',
            url: window.baseRemoteURL + 'networks',
            dataType: 'json',
            async: false,
            cache: true,
            success: function (data) {
                window.networkListCache = data;
                data.forEach(function (item) {
                    jQuery('#network').append(jQuery('<option>').text(item).attr('value', item));
                });
            }
        });
    }
}

function updateData() {
    updateNetworks();
    johng.set(getData());
}

function hmsToSeconds(hmsString) {
    var a = hmsString.split(':');
    var seconds = (+a[0]) * 60 * 60 + (+a[1]) * 60 + (+a[2]);
    return seconds;
}

function removeItems(removeMediaItems) {
    if (Array.isArray(removeMediaItems)) {
        // We have some players that are no longer live and should be destroyed.
        removeMediaItems.forEach(
            function (playerId) {
                if (playerId) {
                    var mediaItem = johng.get().find(data => data.vidid === playerId);
                    jQuery('#' + playerId + '_div').remove();
                    jQuery('#' + playerId + '_preload').remove();
                }
            });
    }
}

function addItems(addMediaItems) {
    // And add them
    if (Array.isArray(addMediaItems)) {
        // Ok, so addMediaItems is an actual Array, so we can loop over it
        addMediaItems.forEach(
            function (playerId) {
                // Does a player window with the same ID already exist?
                var doesPlayerExist = document.getElementById(playerId);

                if (!doesPlayerExist) {
                    // Grab the video's data item because we will need it
                    var mediaItem = johng.all().find(data => data.vidid === playerId);

                    switch (mediaItem.media_type) {
                        case 'video':
                            jQuery("#videos").append(create_video(playerId, mediaItem));

                            Plyr.setup("#" + playerId, { controls: ['current-time', 'airplay', 'fullscreen', 'volume', 'airplay'], clickToPlay: false });

                            //jQuery("#" + playerId).prop("volume", jQuery("#" + playerId).attr('media_volume'));

                            /* THIS IS A BAD USER EXPERIENCE... Commenting out for now.
                            // When mousing over a player, unmute it so we can hear.
                            jQuery(jQuery("#" + playerId + "_div")).mouseenter(function () {
                                if (!jQuery('#' + playerId + '_div').hasClass("highlight") && (mediaItem.media_type == 'video')) {
                                    jQuery('#' + playerId).prop('muted', false);
                                }
                            });

                            // When mousing out of a player, mute it again,
                            // unless it is our main video, in which case don't mute.
                            jQuery(jQuery("#" + playerId + "_div")).mouseleave(function () {
                                if (!jQuery('#' + playerId + '_div').hasClass("highlight")) {
                                    jQuery('#' + playerId).prop('muted', true);
                                }
                            });
                            */

                            if (mediaItem.format == 'm3u8') {
                                if (Hls.isSupported()) {
                                    var video = document.getElementById(playerId);
                                    var config = {
                                        debug: true,
                                    }
                                    var hls = new Hls(config);
                                    // bind them together
                                    hls.attachMedia(video);
                                    console.log("HLS" + mediaItem);
                                    hls.on(Hls.Events.MEDIA_ATTACHED, function () {
                                        hls.loadSource(mediaItem.url);
                                        hls.on(Hls.Events.MANIFEST_PARSED, function (event, data) {
                                            console.log('manifest loaded, found ' + data.levels.length + ' quality level');
                                        });
                                        hls.on(Hls.Events.ERROR, function (event, data) {
                                            if (data.fatal) {
                                                switch (data.type) {
                                                    case Hls.ErrorTypes.NETWORK_ERROR:
                                                        // try to recover network error
                                                        console.log('fatal network error encountered, try to recover');
                                                        hls.startLoad();
                                                        break;
                                                    case Hls.ErrorTypes.MEDIA_ERROR:
                                                        console.log('fatal media error encountered, try to recover');
                                                        hls.recoverMediaError();
                                                        break;
                                                    default:
                                                        // cannot recover
                                                        hls.destroy();
                                                        break;
                                                }
                                            }
                                        });
                                    });
                                }
                            }

                            // This is debugging code that helps me watch for videos that might
                            // be stubborn and not want to download for some reason. The
                            // onloadeddata fires when "data for the current frame is available".
                            // jQuery("#" + playerId).get(0).onloadeddata = (event) => {
                            //     console.log('loaded data for ' + playerId)
                            // };

                            // When clicking a player, make it the main player,
                            jQuery("#" + playerId + "_div div.plyr div:not(.plyr__controls, .plyr__controls *)").click(function () {
                                jQuery('#' + mediaItem.media_type + 'playermain').children().prependTo('#' + mediaItem.media_type + 's');
                                jQuery('#' + playerId).prop('muted', jQuery('#' + playerId).attr('muted'));
                                if (jQuery('#' + playerId + '_div').hasClass("highlight")) {
                                    jQuery('div').removeClass("highlight");
                                    jQuery('#' + playerId).prop('muted', true);
                                } else {
                                    jQuery('div').removeClass("highlight");
                                    jQuery('#' + mediaItem.media_type + 's').find(mediaItem.media_type).prop('muted', true);
                                    jQuery('#' + playerId + '_div').prependTo('#' + mediaItem.media_type + 'playermain')
                                        .addClass("highlight");
                                    jQuery('#' + playerId).prop('muted', false);
                                }
                                return false;
                            });
                            break;

                        case 'audio':
                            jQuery("#audios").append(create_audio(playerId, mediaItem));
                            Plyr.setup("#" + playerId, { controls: ['current-time', 'duration', 'mute', 'volume'] });
                            jQuery("#" + playerId).prop("volume", jQuery("#" + playerId).attr('media_volume'));

                            jQuery("#" + playerId).prop("muted", jQuery("#mute_all_audio").is(':checked'));
                            jQuery("#" + playerId).currentTime = johng.current() - mediaItem.start + mediaItem.jump;

                            // TODO: We're not using promise right now, but will need to later
                            jQuery("#" + playerId).trigger('play');
                            jQuery("#" + playerId).bind("ended", function () {
                                jQuery("#" + $(this).attr('id') + "_div").empty().remove();
                                jQuery("#" + $(this).attr('id') + "_preload").empty().remove();
                            });
                            break;

                        case 'html':
                            jQuery("#htmls").append(create_html(playerId, mediaItem));
                            // TODO: This has some wonky UI right now
                            // setReadMore(playerId);
                            break;

                        case 'modal':
                            if(mediaItem.end > johng.current()) {
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
                                        fadeDuration: 100,
                                        clickClose: false,
                                        blockerClass: "blocker"
                                    })
                                    window.globalModals.push(mediaItem.vidid);
                                    johng.pause();
                                }
                            }
                            break;
                    };

                    if (mediaItem.media_type != 'modal') {
                        // Add video object and title we just created to DOM
                        jQuery("#" + playerId + "_div").prependTo("#" + mediaItem.media_type + "s");
                    };
                }
            });
    }
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
        Source: mediaItem.source,
        StartTime: mediaItem.startTime

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
    current_data = johng.get();
    current_data.forEach(element => {
        if (element.media_type == 'video') {
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
    johng.move(increment);
    setTimeAllPlayers();
}

function setReadMore(playerId) {
    jQuery("#" + playerId).readmore({
        embedCSS: false,
        collapsedHeight: 0,
        speed: 75,
        lessLink: '<button class="command_button" type="button"><span class="btn-text"><a href="#">Read Less</a></span></button>',
        moreLink: '<button class="command_button" type="button"><span class="btn-text"><a href="#">Read More</a></span></button>',
        blockCSS: 'display: inline-block; float: right;'
    });
}
// Jump to the right timestamp
function jumpToTime(stringTimeInput) {
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

    johng.setCurrent(hmsToSeconds(`${hours}:${minutes}:${seconds}`))
    johng.updateClock();
    johng.pause();
    setTimeAllPlayers();
}

// Setup things when the document is ready
jQuery(function () {

    jQuery('.close-modal-boot-button, #hider').click(function (event) {
        jQuery("#chime").trigger('play');
        jQuery("#hider").hide();
        $.modal.close();
        johng.play();
        muteAllPlayers();
    });

    jQuery(".close-modal-button").click(function () {
        $.modal.close();
        johng.play();
    });

    jQuery("#playButton").on("click", function () {
        johng.play();
    });

    jQuery("#syncButton").on("click", function () {
        setTimeAllPlayers();
    });

    jQuery("#loadButton").on("click", function () {
        setTimeAllPlayers();
    });


    jQuery("#pauseButton").on("click", function () {
        johng.pause();
    });

    jQuery('.time-marker').on("click", function () {
        jumpToTime(this.text);
        johng.updateClock();
        johng.play();
    });

    jQuery('.ffrw').on("click", function () {
        moveTime(parseInt(jQuery(this).data("skip")));
    });

    jQuery('#mute_all_audio').click(function () {
        if (jQuery(this).is(':checked')) {
            //unmuteAudioPlayers();
            jQuery('#radio_mute_icon').attr('src', 'img/sound_off.png');
        } else {
            muteAudioPlayers();
            jQuery('#radio_mute_icon').attr('src', 'img/sound_on.png');
        }
    });

    // If updating form fields, add their changes to the URL
    jQuery("#filters input").on("click", updateData);
    jQuery("select").on("change", updateData);

    // Make sure the child players are always paused when the timeline player is also paused
    window.setInterval(function () {
        if (!johng.isPlaying()) {
            pauseAllPlayers();
            setTimeAllPlayers();
        }
    }, playerSync * 1000);

    window.setInterval(function () {
        if (johng.isPlaying()) {
            playAllPlayers();
        }
    }, playerSync * 1000);

    jQuery("#menu-play").click(function () {
        johng.play();
    });

    jQuery("#menu-pause").click(function () {
        johng.pause();
    });

    jQuery("#jumpItButton").click(function () {
        jumpHour = jQuery("#jumpItHour").val();
        jumpMinute = jQuery("#jumpItMinute").val();
        jumpSecond = jQuery("#jumpItSecond").val();
        jumpPeriod = jQuery("#jumpItPeriod").val();

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
        jQuery("#jumpItPeriod").val(jumpPeriod);

        jumpToTime(jumpHour + ":" + jumpMinute + ":" + jumpSecond + " " + jumpPeriod);
    });

    // Every time the media player's time changes, this function weill be called
    // This is our main running function
    johng.tickFunction = function () {
        // Set some variables
        activeItems = johng.get();
        timestamp = johng.current();
        let currentItemsList = [], activeItemsList = [], currentItems = [];

        // We slice the currentItems list so we can an Array instead of an HTMLCollection
        currentItems = Array.prototype.slice.call(document.querySelectorAll("div.htmlitem, video:not(.handsoff), audio:not(.handsoff)"));

        // The activeItems is passed in to the function each time it is run
        activeItemsList = activeItems.map(activeItem => activeItem.vidid);

        // Current items are those currently on the page
        currentItemsList = currentItems.map(currentItem => currentItem.id);

        // Subtract current and active items to determine which items are new, not
        // currently on the page and should be added, and as well trigger items that
        // are no longer active to deactivate.
        addMediaItems = activeItemsList.filter(x => !currentItemsList.includes(x));
        removeMediaItems = currentItemsList.filter(x => !activeItemsList.includes(x));

        // Add New Items to the page that don't already exist
        addItems(addMediaItems);

        // Remove old items from the page that aren't currently active
        removeItems(removeMediaItems);

        jQuery('video:not(.handsoff), audio:not(.handsoff)').each(function () {
            if (jQuery(this).get(0).readyState > 3) {
                // If a video only has a little bit of play info, let's go ahead and set
                // the current time so that it doesn't download extraneous data
                //setTimePlayer(jQuery(this).get(0).id);
            }
        });
        // This function loads the data into johng
        updateData();
    };

    updateData();
    muteAudioPlayers();
    jumpToTime("7:45:00 AM");
    setTimeAllPlayers();
});
