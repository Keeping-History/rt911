from django.db import models

# Create your models here.

class Media(models.Model):
    start_date  = models.DateTimeField()
    end_date    = models.DateTimeField()
    tz          = models.CharField(max_length=4)
    title       = models.CharField(max_length=255)
    source      = models.CharField(max_length=255)
    vidid       = models.CharField(max_length=128)
    url         = models.URLField()
    format      = models.CharField(max_length=10)
    full        = models.CharField(max_length=255)
    approved    = models.BooleanField(default=False, verbose_name= u"\U0001F44D")

    approved.boolean = True

    class Meta:
        ordering = ["start_date"]
        verbose_name_plural = "media"

    def __str__(self):
        return self.full

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

    def duration(self):
            return self.end_date - self.start_date
