import hashlib
from datetime import datetime

from django.db import models
from django.contrib import admin
from django import forms


def default_start_time():
    now = datetime.now()
    start = now.replace(day=11, month=9, year=2001)
    return start


class TagType(models.Model):
    name = models.CharField(max_length=255)

    def __str__(self):
        return self.name


class Tag(models.Model):
    name = models.CharField(max_length=255)
    description = models.CharField(max_length=255)
    type_of = models.ForeignKey(TagType, on_delete=models.SET_NULL, null=True)

    def __str__(self):
        return self.name


class Marker(models.Model):
    name = models.CharField(max_length=255)
    time_marker = models.DateTimeField(default=default_start_time)
    approved = models.BooleanField(default=False)
    approved.boolean = True

    def __str__(self):
        return self.name

    class Meta:
        ordering = ['-time_marker']


class Media(models.Model):
    start_date = models.DateTimeField()
    end_date = models.DateTimeField()
    tz = models.CharField(max_length=4)

    title = models.CharField(max_length=255)
    source = models.CharField(max_length=255)
    full_title = models.CharField(max_length=255, blank=True)

    tags = models.ManyToManyField(Tag, blank=True)
    url = models.URLField(default=None, blank=True)
    format = models.CharField(max_length=5)
    jump = models.IntegerField(default=0)
    trim = models.IntegerField(default=0)
    volume = models.DecimalField(max_digits=5, decimal_places=2, default=1.0)
    mute = models.BooleanField(default=False)

    content = models.TextField(default='', blank=True)
    image = models.URLField(default='', blank=True)
    image_caption = models.TextField(default='', blank=True)

    approved = models.BooleanField(default=False)
    approved.boolean = True

    class Meta:
        ordering = ["start_date"]
        verbose_name = 'media'
        verbose_name_plural = 'media items'

    def __str__(self):
        return self.start_date.strftime('%m/%d/%Y %I:%M %p') + " " + self.source + " " + self.title

    @property
    def vidid(self):
        return 'm' + hashlib.md5(self.url.encode("utf-8")).hexdigest()

    @property
    def adminPlayer(self):
        return '<{type} src="{src}"/>'.format(
            type=self.format,
            src=self.url,
        )

    @property
    def contentPlain(self):
        return BeautifulSoup(self.content, "html.parser").text

    @property
    def mediaType(self):
        mediaTypes = {
            'html': ['html'],
            'audio': ['mp3', 'aac', 'ogg', 'flac', 'webm', 'wav'],
            'video': ['h.264', 'mp4', 'mov', 'mpg', 'webm', 'ogg', 'm3u8', 'm3u'],
            'modal': ['modal'],
            'image': ['jpg', 'png', 'gif']
        }

        for mediaType in mediaTypes:
            if self.format in mediaTypes[mediaType]:
                return mediaType

    @property
    def duration(self):
        return self.end_date - self.start_date

    def save(self, *args, **kwargs):
        if not self.full_title:
            self.full_title = self.title
        super(Media, self).save(*args, **kwargs)


class Collection(models.Model):
    name = models.CharField(max_length=255)
    description = models.CharField(max_length=255)
    media = models.ManyToManyField(to=Media, blank=True, limit_choices_to={'approved': True})

    def __str__(self):
        return self.name
