# Generated by Django 3.2.12 on 2022-03-12 08:02

from django.db import migrations


class Migration(migrations.Migration):

    dependencies = [
        ('media', '0019_alter_media_timezone'),
    ]

    operations = [
        migrations.RemoveField(
            model_name='media',
            name='timezone_offset',
        ),
    ]