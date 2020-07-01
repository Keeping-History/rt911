# Generated by Django 3.0.3 on 2020-02-20 05:00

from django.db import migrations, models


class Migration(migrations.Migration):

    initial = True

    dependencies = [
    ]

    operations = [
        migrations.CreateModel(
            name='Media',
            fields=[
                ('id', models.AutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('start_date', models.CharField(max_length=2)),
                ('end_date', models.CharField(max_length=2)),
                ('start_time', models.CharField(max_length=5)),
                ('end_time', models.CharField(max_length=5)),
                ('tz', models.CharField(max_length=4)),
                ('title', models.CharField(max_length=255)),
                ('source', models.CharField(max_length=255)),
                ('vidid', models.CharField(max_length=128)),
                ('url', models.URLField()),
                ('format', models.CharField(max_length=10)),
                ('full', models.CharField(max_length=255)),
            ],
        ),
    ]