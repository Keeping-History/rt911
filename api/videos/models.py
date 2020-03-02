from django.db import models

# Create your models here.

class Video(models.Model):
    start_date  = models.DateTimeField()
    end_date    = models.DateTimeField()
    tz          = models.CharField(max_length=4)
    title       = models.CharField(max_length=255)
    source      = models.CharField(max_length=255)
    vidid       = models.CharField(max_length=128)
    url         = models.URLField()
    format      = models.CharField(max_length=10)
    full        = models.CharField(max_length=255)

    def __str__(self):
        return self.full
