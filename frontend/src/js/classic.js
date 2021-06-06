function isMobile() {
    try {
        document.createEvent("TouchEvent");
        return true;
    } catch (e) {
        return false;
    }
}

jQuery(function () {
    //Make windows movable and make sure the active window is on top
    jQuery(".draggable-window").draggable({
        handle: "h1.title",
        start: function () {
            jQuery(".content").css("z-index", "1100");
            jQuery(this).css("z-index", "1200");
        },
    });

    //Make windows resizable
    //TODO: This is not currently working because we don't have a grab button
    jQuery(".resizable").resizable({
        handles: "se",
        stop: function (event, ui) {
            jQuery("#sound_move_stop").trigger("play");
        },
    });

    // Zoom Box -- Make Window Full Screen and toggle back
    jQuery(".zoom-box").on("click", function () {
        b = this.closest(".content");
        isMax = jQuery(this).data("max");

        if (!isMax) {
            jQuery(b)
                .css("width", "99%")
                .css("height", "95%")
                .css("left", ".5rem")
                .css("top", "2.5rem");

            jQuery(this)
                .data("width", jQuery(b).css("width"))
                .data("height", jQuery(b).css("height"))
                .data("top", jQuery(b).css("top"))
                .data("left", jQuery(b).css("left"))
                .data("max", true);

            jQuery("#sound_windowshade_expand").trigger("play");
        } else {
            jQuery(b).removeAttr("style");
            jQuery("#sound_windowshade_collapse").trigger("play");

            jQuery(this).data("max", false);
        }
    });

    // Windowshade Box -- Minimize the window to just the title bar
    jQuery(".windowshade-box").on("click", function () {
        c = jQuery(this).closest(".content");
        c.css("z-index", "1");
        d = jQuery(this).data("shade");
        e = jQuery(this).data("shade-height", jQuery(this).css("height"));
        if (!d) {
            jQuery(c).children(".inner").addClass("hidden");
            jQuery(c).css("height", "");
            jQuery(this).data("shade", true);
            jQuery("#sound_windowshade_collapse").trigger("play");
        } else {
            jQuery(c).children(".inner").removeClass("hidden");
            jQuery(c).css("height", e);
            jQuery(this).data("shade", false);
            jQuery("#sound_windowshade_expand").trigger("play");
        }
    });

    // Close Box -- Close the window when clicked
    jQuery(".close-box, .close-button").on("click", function () {
        a = this.closest(".content");
        jQuery(a).addClass("hidden");
        jQuery("#sound_close").trigger("play");
    });

    // Enable Desktop Icons
    if (isMobile()) {
        jQuery(".icon").on("click", function () {
            jQuery("#" + jQuery(this).get(0).id.split("-")[1])
                .removeClass("hidden")
                .css("z-index", "9000");
            jQuery("#sound_open").trigger("play");
        });
    } else {
        jQuery(".draggable-icon").draggable({});
        jQuery(".icon").on("dblclick", function () {
            jQuery("#" + jQuery(this).get(0).id.split("-")[1])
                .removeClass("hidden")
                .css("z-index", "9000");
            jQuery("#sound_open").trigger("play");
        });
    }

    // Make sure the active window is on top
    jQuery(".content").on("click", function () {
        jQuery(".content").css("z-index", "1100");
        jQuery(this).css("z-index", "1200");
    });

    jQuery("#nav-list li").on("click touch", function () {
        jQuery(this).children().show();
    });

    jQuery("#nav-list li").on("mouseleave", function () {
        jQuery(this).children("ul").hide();
    });

    // Enable menu items to be clickable by default and open a windows/app with the same name
    jQuery("#nav-list li ul li").on("click", function () {
        jQuery("#sound_open").trigger("play");
        jQuery("#" + jQuery(this).get(0).id.split("-")[1])
            .removeClass("hidden")
            .css("z-index", "9000");
    });

    jQuery("#modalBoot").modal({
        show: true,
        escapeClose: false,
        clickClose: false,
        showClose: false,
        fadeDuration: 250,
        clickClose: false,
        blockerClass: "blocker",
    });
});
