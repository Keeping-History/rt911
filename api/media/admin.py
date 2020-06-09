from django.contrib import admin
from rangefilter.filter import DateRangeFilter, DateTimeRangeFilter
from import_export import resources
from import_export.admin import ImportExportModelAdmin

import logging

from .models import Media, Tag

logger = logging.getLogger(__name__)

class MediaResource(resources.ModelResource):
    class Meta:
        model = Media


class TagResource(resources.ModelResource):
    class Meta:
        model = Tag

def approve_media(modeladmin, request, queryset):
    for media in queryset:
        media.approved = True
        media.save()
approve_media.short_description = 'Approve Media'

class MediaAdmin(ImportExportModelAdmin):
    list_display = ['approved', 'duration', 'title' ,'start_date', 'end_date', 'source', 'tz', 'mediaType']
    list_filter = [ ('start_date', DateTimeRangeFilter), ('end_date', DateTimeRangeFilter), 'approved', 'source', 'format']
    search_fields = ['full']
    date_hierarchy = 'start_date'
    actions = [approve_media]
    resource_class = MediaResource


class TagAdmin(ImportExportModelAdmin):
    model = Tag
    list_display = ['name', 'description']

admin.site.register(Media, MediaAdmin)
admin.site.register(Tag, TagAdmin)
