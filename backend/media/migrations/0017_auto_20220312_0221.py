# Generated by Django 3.2.12 on 2022-03-12 02:21

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('media', '0016_remove_media_tz'),
    ]

    operations = [
        migrations.AddField(
            model_name='media',
            name='tz',
            field=models.TextField(blank=True, default='EDT'),
        ),
        migrations.AddField(
            model_name='media',
            name='tz_offset',
            field=models.IntegerField(default=0),
        ),
    ]
