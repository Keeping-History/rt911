jQuery(function () {
    //Make windows movable and make sure the active window is on top
    jQuery(".draggable-window").draggable({
        handle: "h1.title",
        start: function () {
            jQuery(".content").css("z-index", "1100");
            jQuery(this).css("z-index", "1200");
        },
    });

    //Make icons movable
    jQuery(".draggable-icon").draggable();

    //Make windows resizable
    //TODO: This is not currently working because we don't have a grab button
    jQuery(".resizable").resizable({
        handles: "se"
    });

    //Enable Icons and Menu items to be clickable and open their windows/apps
    jQuery(".icon").dblclick(function () {
        jQuery("#" + jQuery(this).get(0).id.split("-")[1]).removeClass('hidden').css("z-index", "9000");
    })

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

        } else {
            jQuery(b)
                .css("width", jQuery(this).data("width"))
                .css("height", jQuery(this).data("height"))
                .css("top", jQuery(this).data("top"))
                .css("left", jQuery(this).data("left"))
                .css("z-index","900")

            jQuery(this)
                .data("max", false);

        }
    });

    // Windowshade Box -- Minimize the window to just the title bar
    jQuery(".windowshade-box").on("click", function () {
        c = jQuery(this).closest(".content");
        c.css("z-index", "1");
        d = jQuery(this).data("shade");
        e = jQuery(this).data("shade-height", jQuery(this).css("height"));
        if (!d) {
            jQuery(c).children('.inner').addClass('hidden');
            jQuery(c).css('height', "");
            jQuery(this).data("shade", true);
        } else {
            jQuery(c).children('.inner').removeClass('hidden');
            jQuery(c).css("height", e);
            jQuery(this).data("shade", false);
        }
    });
    
    // Close Box -- Close the window when clicked
    jQuery(".close-box, .close-button").on("click", function () {
        a = this.closest(".content");
        jQuery(a).addClass('hidden');
    });

    // Make sure the active window is on top
    jQuery(".content").click(function () {
        jQuery(".content").css("z-index", "1100")
        jQuery(this).css("z-index", "1200");
    });

    // Menu Items - show and hide menu items and drop downs
    jQuery("#nav-list li").on("mouseenter", function () {
        jQuery(this).children().show();
    });

    jQuery("#nav-list li").on("mouseleave", function () {
        jQuery(this).children("ul").hide();
    });

    jQuery("#nav-list li").on("click", function () {
        jQuery(this).children("ul").hide();
    });

    // Enable menu items to be clickable by default and open a windows/app with the same name
    jQuery("#nav-list li ul li").click(function () {
        jQuery("#" + jQuery(this).get(0).id.split("-")[1]).removeClass('hidden').css("z-index", "9000");
    })

    jQuery('#modalBoot').modal({
        backdrop: true,
        show: true,
        showClose: false,
        fadeDuration: 250
    });

});
