from django.contrib import admin
from .models import Media

class MediaAdmin(admin.ModelAdmin):
    list_display = ['approved', 'duration', 'title' ,'start_date', 'end_date', 'source', 'tz', 'format', 'mediaType']
    list_filter = ['approved']
    search_fields = ['full']

admin.site.register(Media, MediaAdmin)
