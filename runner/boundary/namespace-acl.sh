#!/bin/sh
# Trusted supervisor only, run INSIDE dedicated VM with sudo. No worker capabilities.
# Install before executing worker code; caller starts only a harmless dormant gate first.
set -eu
worker_pid=$1
broker_ip=$2
broker_port=$3
case "$worker_pid" in ''|*[!0-9]*) exit 2;; esac
case "$broker_ip" in 172.*) ;; *) exit 2;; esac
case "$broker_ip" in *[!0-9.]*) exit 2;; esac
case "$broker_port" in ''|*[!0-9]*) exit 2;; esac
[ "$worker_pid" -gt 1 ] && [ "$broker_port" -ge 1024 ] && [ "$broker_port" -le 65535 ]
# Refuse accidentally targeting the VM's own network namespace.
[ "$(readlink /proc/1/ns/net)" != "$(readlink /proc/$worker_pid/ns/net)" ]
nsenter -t "$worker_pid" -n iptables -w -P OUTPUT DROP
nsenter -t "$worker_pid" -n iptables -w -P INPUT DROP
nsenter -t "$worker_pid" -n iptables -w -P FORWARD DROP
nsenter -t "$worker_pid" -n iptables -w -F
nsenter -t "$worker_pid" -n iptables -w -A OUTPUT -d "$broker_ip" -p tcp --dport "$broker_port" -m conntrack --ctstate NEW,ESTABLISHED -j ACCEPT
nsenter -t "$worker_pid" -n iptables -w -A INPUT -s "$broker_ip" -p tcp --sport "$broker_port" -m conntrack --ctstate ESTABLISHED -j ACCEPT
nsenter -t "$worker_pid" -n ip6tables -w -P OUTPUT DROP
nsenter -t "$worker_pid" -n ip6tables -w -P INPUT DROP
nsenter -t "$worker_pid" -n ip6tables -w -P FORWARD DROP
nsenter -t "$worker_pid" -n ip6tables -w -F
# No DNS, host/VM gateways, arbitrary CONNECT, host sockets or public port forwards.
# Docker DNS NAT redirect is still unreachable: its translated loopback destination
# does not match the sole OUTPUT allow rule. Read back both tables for the receipt.
nsenter -t "$worker_pid" -n iptables-save -t filter
nsenter -t "$worker_pid" -n ip6tables-save -t filter
