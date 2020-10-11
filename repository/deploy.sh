#!/bin/bash

export host_name=$(curl http://169.254.169.254/latest/meta-data/hostname)
export instance_id=$(curl http://169.254.169.254/latest/meta-data/instance-id)
echo "<html><head><link rel=\\"stylesheet\\" href=\\"https://cdn.jsdelivr.net/gh/kognise/water.css@latest/dist/dark.min.css\\"></head><body><h3>Hello from $host_name ($instance_id) in AZ $az.</h3>" > /var/www/html/index.html
