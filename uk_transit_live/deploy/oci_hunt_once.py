"""Time-boxed Oracle A1 capacity hunt, for CI runners.

Same job as oci_launch.py, but bounded: it hunts for a fixed number of seconds
and then exits cleanly so a scheduled workflow can end and be billed for one
short run.  oci_launch.py stays as-is for the laptop, where running forever is
the point.

Exit codes are deliberately narrow, because a scheduled workflow that "fails"
on the normal outcome trains you to ignore its failure mails:
    0  ran fine - won or not, see the outputs
    1  configuration or permission problem worth a human look

GitHub Actions outputs (written to $GITHUB_OUTPUT when present):
    won=true|false      an instance named INSTANCE_NAME is RUNNING
    fresh=true|false    this run is what launched it (deploy only on fresh)
    ip=<address>        public IP of the instance

The IP is printed rather than masked.  It is the address of a public website,
so it is not a secret, and ::add-mask:: values are redacted out of job outputs
and step summaries - masking it would break the deploy step that needs it.
The new instance only has key-only SSH reachable until deploy runs.

Nothing sensitive is printed.  Oracle SDK errors are reported as
type/status/code only - never the exception's full repr, which can carry
request headers into a world-readable public log.

Usage:  python deploy/oci_hunt_once.py --budget-seconds 240
"""
import argparse
import os
import sys
import time

import oci

PUBKEY = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILJ9TSdQ90KUlQt6klsdTq9O"
          "/RChU8rlcJQw8/1ygl0l uk-transit-deploy")
VCN_NAME = "uk-transit-vcn"
INSTANCE_NAME = "uk-transit-live"
SHAPE_SIZES = [(1, 6), (2, 12)]   # alternate per round; both Always Free
LIVE_STATES = ("RUNNING", "PROVISIONING", "STARTING")
OPEN_PORTS = [22, 80, 443, 8620]


def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def emit(**outputs):
    """Write step outputs for the workflow; harmless when run locally."""
    path = os.environ.get("GITHUB_OUTPUT")
    if not path:
        log("outputs: " + " ".join(f"{k}={v}" for k, v in outputs.items()))
        return
    with open(path, "a", encoding="utf-8") as fh:
        for k, v in outputs.items():
            fh.write(f"{k}={v}\n")


def svc_error(prefix, e):
    """Report a ServiceError without leaking request detail into the log."""
    log(f"{prefix}: HTTP {e.status} {e.code}")


def public_ip_of(compute, vnet, tenancy, instance_id):
    for va in compute.list_vnic_attachments(
            compartment_id=tenancy, instance_id=instance_id).data:
        vnic = vnet.get_vnic(va.vnic_id).data
        if vnic.public_ip:
            return vnic.public_ip
    return None


def open_ports(vnet, subnet):
    """Best-effort: a least-privilege CI user may not manage the VCN, and the
    ports are already open from the first laptop run.  Never fatal."""
    for sl_id in subnet.security_list_ids:
        try:
            sl = vnet.get_security_list(sl_id).data
            have = {r.tcp_options.destination_port_range.min
                    for r in sl.ingress_security_rules
                    if r.protocol == "6" and r.tcp_options
                    and r.tcp_options.destination_port_range}
            missing = [p for p in OPEN_PORTS if p not in have]
            if not missing:
                log("security list: ports already open")
                continue
            rules = list(sl.ingress_security_rules)
            for p in missing:
                rules.append(oci.core.models.IngressSecurityRule(
                    protocol="6", source="0.0.0.0/0", is_stateless=False,
                    tcp_options=oci.core.models.TcpOptions(
                        destination_port_range=oci.core.models.PortRange(
                            min=p, max=p))))
            vnet.update_security_list(
                sl_id,
                oci.core.models.UpdateSecurityListDetails(
                    ingress_security_rules=rules,
                    egress_security_rules=sl.egress_security_rules))
            log(f"security list: opened {missing}")
        except oci.exceptions.ServiceError as e:
            svc_error("security list not updated (continuing)", e)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget-seconds", type=int, default=240,
                    help="stop starting new rounds after this long")
    ap.add_argument("--round-sleep", type=int, default=30,
                    help="pause between full AD rounds")
    ap.add_argument("--open-ports", action="store_true",
                    help="also reconcile the subnet security list")
    args = ap.parse_args()

    deadline = time.monotonic() + args.budget_seconds

    try:
        config = oci.config.from_file()
    except Exception as e:                      # noqa: BLE001 - message only
        log(f"cannot read OCI config: {type(e).__name__}")
        return 1

    tenancy = config["tenancy"]
    identity = oci.identity.IdentityClient(config)
    vnet = oci.core.VirtualNetworkClient(config)
    compute = oci.core.ComputeClient(config)

    # ---- already have one?  never launch a second -------------------------
    for st in LIVE_STATES:
        try:
            existing = compute.list_instances(
                compartment_id=tenancy, display_name=INSTANCE_NAME,
                lifecycle_state=st).data
        except oci.exceptions.ServiceError as e:
            svc_error("cannot list instances", e)
            return 1
        if existing:
            inst = existing[0]
            log(f"instance already exists ({st}) - not launching another")
            ip = public_ip_of(compute, vnet, tenancy, inst.id) if st == "RUNNING" else None
            emit(won="true", fresh="false", ip=ip or "")
            return 0

    # ---- network + image --------------------------------------------------
    try:
        vcn = next(v for v in vnet.list_vcns(compartment_id=tenancy).data
                   if v.display_name == VCN_NAME)
        subnets = vnet.list_subnets(compartment_id=tenancy, vcn_id=vcn.id).data
        subnet = next(s for s in subnets if not s.prohibit_public_ip_on_vnic)
        image = compute.list_images(
            compartment_id=tenancy, operating_system="Canonical Ubuntu",
            operating_system_version="24.04", shape="VM.Standard.A1.Flex",
            sort_by="TIMECREATED", sort_order="DESC").data[0]
        ads = identity.list_availability_domains(tenancy).data
    except StopIteration:
        log(f"no VCN named {VCN_NAME} with a public subnet")
        return 1
    except oci.exceptions.ServiceError as e:
        svc_error("network/image lookup failed", e)
        return 1

    log(f"image {image.display_name}; {len(ads)} ADs")
    if args.open_ports:
        open_ports(vnet, subnet)

    # ---- hunt until the budget runs out -----------------------------------
    inst = None
    attempt = 0
    rnd = 0
    while inst is None and time.monotonic() < deadline:
        ocpus, mem = SHAPE_SIZES[rnd % len(SHAPE_SIZES)]
        rnd += 1
        details = dict(
            compartment_id=tenancy,
            display_name=INSTANCE_NAME,
            shape="VM.Standard.A1.Flex",
            shape_config=oci.core.models.LaunchInstanceShapeConfigDetails(
                ocpus=ocpus, memory_in_gbs=mem),
            source_details=oci.core.models.InstanceSourceViaImageDetails(
                image_id=image.id),
            create_vnic_details=oci.core.models.CreateVnicDetails(
                subnet_id=subnet.id, assign_public_ip=True),
            metadata={"ssh_authorized_keys": PUBKEY},
        )
        for ad in list(ads):
            if time.monotonic() >= deadline:
                break
            attempt += 1
            try:
                inst = compute.launch_instance(
                    oci.core.models.LaunchInstanceDetails(
                        availability_domain=ad.name, **details)).data
                log(f"LAUNCHED {ocpus}cpu/{mem}gb in {ad.name} "
                    f"after {attempt} attempts")
                break
            except oci.exceptions.ServiceError as e:
                msg = (e.message or "").lower()
                if e.status == 500 and "capacity" in msg:
                    log(f"attempt {attempt}: {ad.name} out of capacity")
                elif e.status == 429:
                    log(f"attempt {attempt}: rate limited, backing off 60s")
                    time.sleep(60)
                elif e.status == 404:
                    log(f"attempt {attempt}: {ad.name} does not offer A1, skipping")
                    ads = [a for a in ads if a.name != ad.name]
                elif e.status in (400, 401, 403):
                    svc_error(f"attempt {attempt}: fatal", e)
                    return 1
                else:
                    svc_error(f"attempt {attempt}: {ad.name}", e)
            except (oci.exceptions.RequestException,
                    oci.exceptions.ConnectTimeout, OSError) as e:
                log(f"attempt {attempt}: network error ({type(e).__name__})")
                time.sleep(5)
        if inst is None and time.monotonic() < deadline:
            time.sleep(args.round_sleep)

    if inst is None:
        log(f"no capacity this run ({attempt} attempts)")
        emit(won="false", fresh="false", ip="")
        return 0

    # ---- won: wait for RUNNING, report the address ------------------------
    try:
        inst = oci.wait_until(compute, compute.get_instance(inst.id),
                              "lifecycle_state", "RUNNING",
                              max_wait_seconds=900).data
        ip = public_ip_of(compute, vnet, tenancy, inst.id)
    except Exception as e:                      # noqa: BLE001 - message only
        log(f"launched, but waiting for RUNNING failed: {type(e).__name__}")
        emit(won="true", fresh="true", ip="")
        return 0

    log(f"instance RUNNING at {ip}")
    emit(won="true", fresh="true", ip=ip or "")
    return 0


if __name__ == "__main__":
    sys.exit(main())
