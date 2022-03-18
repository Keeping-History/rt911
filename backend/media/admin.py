from django.contrib import admin
from rangefilter.filter import DateRangeFilter, DateTimeRangeFilter
from import_export import resources
from import_export.admin import ImportExportModelAdmin
from django.utils.html import format_html
import datetime

import logging

from .models import Media, Tag, TagType, Collection, Marker

logger = logging.getLogger(__name__)

class MediaResource(resources.ModelResource):
    class Meta:
        model = Media

class TagTypeResource(resources.ModelResource):
    class Meta:
        model = TagType

class TagResource(resources.ModelResource):
    class Meta:
        model = Tag

def approve_media(modeladmin, request, queryset):
    for media in queryset:
        media.approved = True
        media.save()
approve_media.short_description = 'Approve Media'

def disapprove_media(modeladmin, request, queryset):
    for media in queryset:
        media.approved = False
        media.save()
disapprove_media.short_description = 'Disapprove Media'

class CollectionInline(admin.TabularInline):
    model = Collection.media.through

class CollectionAdmin(ImportExportModelAdmin):
    model = Collection
    list_display = ['description']
    filter_horizontal = ('media',)
    search_fields = ['name', 'description',]
    inlines = (CollectionInline,)
    exclude = ('media',)

class MediaAdmin(ImportExportModelAdmin):
    readonly_fields=('calcDuration')
    list_display = ['approved', 'duration', 'title' ,'start_date', 'end_date', 'timezone', 'source', 'mediaType', 'sort', 'calcDuration']
    list_filter = [ ('start_date', DateTimeRangeFilter), ('end_date', DateTimeRangeFilter), 'approved', 'source', 'format']
    date_hierarchy = 'start_date'
    actions = [approve_media, disapprove_media, ]
    resource_class = MediaResource
    search_fields = ('title', 'full_title', 'source', 'content', 'image_caption')
    actions_selection_counter = True
    inlines = (CollectionInline,)
    fieldsets= (
        ('Date', {
            'fields': (('start_date', 'end_date', 'timezone'),)
        }),
        ('Info', {
            'fields': ('title', 'source', 'full_title', 'tags', 'approved', 'sort')
        }),
        ('Media', {
            'fields': ('preview_media', 'url', 'format', ('jump', 'trim', 'volume'), ),
        }),
        ('Content', {
            'fields': ('content', 'preview_image', 'image', 'image_caption', )
        }),
    )
    readonly_fields = ('preview_media', 'preview_image', )

    def preview_media(self, obj):
        return (format_html("<%s src='%s' controls=true class='preview' />" % (obj.mediaType, obj.url)))
 
    preview_media.short_description = "Preview Media"

    def preview_image(self, obj):
        return (format_html("<img src='%s' class='preview' />" % (obj.image)))

    preview_image.short_description = "Preview Image"


def assign_person_tagtype(modeladmin, request, queryset):
    for media in queryset:
        TagType(1, name='Person').save()
        media.type_of = TagType(1)
        media.save()

def assign_topic_tagtype(modeladmin, request, queryset):
    for media in queryset:
        TagType(2, name='Topic').save()
        media.type_of = TagType(2)
        media.save()


def assign_military_tagtype(modeladmin, request, queryset):
    for media in queryset:
        TagType(3, name='Military').save()
        media.type_of = TagType(3)
        media.save()

assign_person_tagtype.short_description = 'Make Person'
assign_topic_tagtype.short_description = 'Make Topic'
assign_military_tagtype.short_description = 'Make Military'

class TagAdmin(ImportExportModelAdmin):
    model = Tag
    list_display = ['name', 'description', 'type_of']
    search_fields = ('name', 'description')
    actions = [assign_person_tagtype,
    assign_topic_tagtype, assign_military_tagtype]

class TagTypeAdmin(ImportExportModelAdmin):
    model = TagType
    list_display = ['name']

class MarkerAdmin(ImportExportModelAdmin):
    model = Marker
    list_display = ['approved', 'name', 'time_marker']

admin.site.register(Media, MediaAdmin)
admin.site.register(Tag, TagAdmin)
admin.site.register(TagType, TagTypeAdmin)
admin.site.register(Collection, CollectionAdmin)
admin.site.register(Marker, MarkerAdmin)
