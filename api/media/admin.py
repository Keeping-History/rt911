from django.contrib import admin
from .models import Media

class MediaAdmin(admin.ModelAdmin):
    list_display = ['approved', 'duration', 'title' ,'start_date', 'end_date', 'source', 'tz', 'format', 'mediaType']
    list_filter = ['approved', 'source', 'format']
    search_fields = ['full']
    date_hierarchy = 'start_date'

admin.site.register(Media, MediaAdmin)
