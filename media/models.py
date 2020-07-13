import hashlib

from django.db import models
from django_mysql.models import ListCharField
from bs4 import BeautifulSoup


class Tag(models.Model):
    name = models.CharField(max_length=255)
    description = models.CharField(max_length=255)

    def __str__(self):
        return self.name


class Media(models.Model):
    start_date = models.DateTimeField()
    end_date = models.DateTimeField()
    tz = models.CharField(max_length=4)
    title = models.CharField(max_length=255)
    source = models.CharField(max_length=255)
    url = models.URLField(default=None)
    format = models.CharField(max_length=10)
    full_title = models.CharField(max_length=255)
    content = models.TextField(default=None)
    approved = models.BooleanField(default=False)
    jump = models.IntegerField(default=0)
    trim = models.IntegerField(default=0)
    tags = models.ManyToManyField(Tag)
    image = models.URLField(default=None)
    image_caption = models.TextField(default=None)

    approved.boolean = True

    class Meta:
        ordering = ["start_date"]
        verbose_name = 'media'
        verbose_name_plural = 'media items'

    def __str__(self):
        return self.full_title

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
        return BeautifulSoup(self.content, "lxml").text

    @property
    def mediaType(self):
        mediaTypes = {
            'video': set(['h.264', 'mp4', 'mov', 'mpg', 'webm', 'ogg']),
            'audio': set(['mp3', 'aac', 'ogg', 'flac', 'webm', 'wav']),
            'html': set(['html']),
            'iframe': set(['iframe']),
            'image': set(['jpg', 'png', 'gif']),
        }
        for mediaType in mediaTypes:
            if self.format in mediaTypes[mediaType]:
                return mediaType
            else:
                return self.format

    @property
    def duration(self):
        return self.end_date - self.start_date
