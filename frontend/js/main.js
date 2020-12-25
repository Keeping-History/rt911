// The 9/11RT johng
// A live re-creation of real-time media from September 11, 2001,
// told in by media, photos, audio and other media timestamped and
// replayed in real time. The time starts at September 11, 2001 at
// Midnight Eastern Time, and runs to 11:59:59 PM the same day.
//

// Setup things when the document is ready
$(function () {
    muteAudioPlayers();
    updateData();
    pauseAllPlayers();

    $("#nav-list li").on("mouseenter", function () {
        $(this).children().show();
    });

    $("#nav-list li").on("mouseleave", function () {
        $(this).children("ul").hide();
    });
    $("#nav-list li").on("click", function () {
        $(this).children("ul").hide();
    });


    $(".close-modal-button").click(function () {
        $.modal.close();
        $("#timekeeper").trigger('play');
    })

    $('.close-modal-command').click(function (event) {
        event.preventDefault();
        $.modal.close();
        $("#timekeeper").trigger('play');
    })

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
        console.log(parseInt($(this).data("skip")));
        moveTime(parseInt($(this).data("skip")));
    });

    $('#mute_all_audio').click(function () {
        if ($(this).is(':checked')) {
            muteAudioPlayers();
            $('#radio_mute_icon').attr('src', 'https://win98icons.alexmeub.com/icons/png/loudspeaker_muted-0.png');
        } else {
           //unmuteAudioPlayers();
            $('#radio_mute_icon').attr('src', 'https://win98icons.alexmeub.com/icons/png/loudspeaker_rays-0.png');
        }
    });

    // If updating form fields, add their changes to the URL
    $("#filters input").on("click", updateData);
    $("select").on("change", updateData);

    // Make sure the child players are always paused when the timeline player is also paused
    window.setInterval(function () {
        if (!isPlaying('timekeeper')) {
            pauseAllPlayers()
        };
    }, 1000);

    // Add listeners so that when our main media player is moved others do the same
    addTimekeeperListeners();

});
