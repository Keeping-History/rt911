// The 9/11RT johng
// A live re-creation of real-time media from September 11, 2001,
// told in by media, photos, audio and other media timestamped and
// replayed in real time. The time starts at September 11, 2001 at
// Midnight Easter Time, and runs to 11:59:59 PM the same day.
//

window.start = "08:46:15";

updateData();

// Setup things when the document is ready
$(function () {

    $("#closemodal span.form-check-x").on("click", function() {
        $('#modalModal').modal('hide');
    })

    $('#modalModal').on('show.bs.modal', function (e) {
        $("#timekeeper").trigger('pause');
    })
    $('#modalModal').on('hide.bs.modal', function (e) {
        $("#timekeeper").trigger('play');
    })
    $(".nav-link").click(function () {
        pauseAllPlayers();
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
        moveTime($(this).data("skip"));
    });

    // If updating form fields, add their changes to the URL
    $("#filters input").on("click", updateData);
    $("select").on("change", updateData);

    // Add listeners so that when our main media player is moved others do the same
    addTimekeeperListeners();

    // Make sure the child players are always paused when the timeline player is also paused
    window.setInterval(function () {
        if (!isPlaying('timekeeper')) {
            pauseAllPlayers()
        };
    }, 1000);
    // Enable our tooltips for navigation items
    $('[data-toggle="tooltip"]').tooltip();

    // Turn on our AOL hold overlay and start the show
    //overlayOn();
    //$('#aol').trigger("play");

    // Once the AOL vid is done, let's close it.
    $('#aol').on("ended", function(){
        overlayOff();
    })

    $('#closeaudio').on('click', function() {
        muteAudioPlayers();
        $('#audiocards').hide();
  })

    $('#closehtml').on('click', function () {
        $('#htmlcards').hide();
    })

    $('#closevideo').on('click', function () {
        $('#videocards').hide();
    })

    // Once the pop-up is gone, remove the remove button.
    $('#closepopup').on('click', function(){
        overlayOff();
    })

    muteAudioPlayers();

    $('#mute_all_audio').click(function () {
        if ($(this).is(':checked')) {
            muteAudioPlayers();
            $('#radio_mute_icon').attr('src', 'https://win98icons.alexmeub.com/icons/png/loudspeaker_muted-0.png');
        } else {
           //unmuteAudioPlayers();
            $('#radio_mute_icon').attr('src', 'https://win98icons.alexmeub.com/icons/png/loudspeaker_rays-0.png');
        }
    });
});
