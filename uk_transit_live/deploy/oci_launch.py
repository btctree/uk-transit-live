"""Launch the uk-transit-live A1.Flex instance, retrying until Oracle has capacity.

Oracle's Always Free Arm shape (VM.Standard.A1.Flex) is chronically out of
capacity in uk-london-1; the console wizard just fails.  This script retries
LaunchInstance across all availability domains until one sticks, then waits
for RUNNING and prints the public IP.

Usage:  py deploy/oci_launch.py            (uses ~/.oci/config [DEFAULT])
"""
import sys
import time

import oci

PUBKEY = ("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILJ9TSdQ90KUlQt6klsdTq9O"
          "/RChU8rlcJQw8/1ygl0l uk-transit-deploy")
VCN_NAME = "uk-transit-vcn"
INSTANCE_NAME = "uk-transit-live"
SHAPE_SIZES = [(1, 6), (2, 12)]   # alternate per round; both Always Free
RETRY_SLEEP = 90          # seconds between full AD rounds (45s tripped 429s)
OPEN_PORTS = [22, 80, 443, 8620]

config = oci.config.from_file()
tenancy = config["tenancy"]
identity = oci.identity.IdentityClient(config)
vnet = oci.core.VirtualNetworkClient(config)
compute = oci.core.ComputeClient(config)

def log(msg):
    print(time.strftime("%H:%M:%S"), msg, flush=True)

# ---- network lookups -------------------------------------------------------
vcn = next(v for v in vnet.list_vcns(compartment_id=tenancy).data
           if v.display_name == VCN_NAME)
subnets = vnet.list_subnets(compartment_id=tenancy, vcn_id=vcn.id).data
public_subnet = next(s for s in subnets if not s.prohibit_public_ip_on_vnic)
log(f"VCN {vcn.display_name}  public subnet {public_subnet.display_name}")

# ---- open the app ports in the subnet's security list ----------------------
for sl_id in public_subnet.security_list_ids:
    sl = vnet.get_security_list(sl_id).data
    have = {r.tcp_options.destination_port_range.min
            for r in sl.ingress_security_rules
            if r.protocol == "6" and r.tcp_options
            and r.tcp_options.destination_port_range}
    missing = [p for p in OPEN_PORTS if p not in have]
    if missing:
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
        log(f"security list {sl.display_name}: opened {missing}")
    else:
        log(f"security list {sl.display_name}: ports already open")

# ---- image -----------------------------------------------------------------
image = compute.list_images(
    compartment_id=tenancy, operating_system="Canonical Ubuntu",
    operating_system_version="24.04", shape="VM.Standard.A1.Flex",
    sort_by="TIMECREATED", sort_order="DESC").data[0]
log(f"image {image.display_name}")

ads = identity.list_availability_domains(tenancy).data
log(f"ADs: {[a.name for a in ads]}")

# ---- reuse an existing instance if a previous run already launched one -----
for st in ("RUNNING", "PROVISIONING", "STARTING"):
    existing = compute.list_instances(
        compartment_id=tenancy, display_name=INSTANCE_NAME,
        lifecycle_state=st).data
    if existing:
        inst = existing[0]
        log(f"found existing instance {inst.id} ({st})")
        break
else:
    inst = None
    attempt = 0
    rnd = 0
    while inst is None:
        ocpus, mem = SHAPE_SIZES[rnd % len(SHAPE_SIZES)]
        rnd += 1
        details_base = dict(
            compartment_id=tenancy,
            display_name=INSTANCE_NAME,
            shape="VM.Standard.A1.Flex",
            shape_config=oci.core.models.LaunchInstanceShapeConfigDetails(
                ocpus=ocpus, memory_in_gbs=mem),
            source_details=oci.core.models.InstanceSourceViaImageDetails(
                image_id=image.id),
            create_vnic_details=oci.core.models.CreateVnicDetails(
                subnet_id=public_subnet.id, assign_public_ip=True),
            metadata={"ssh_authorized_keys": PUBKEY},
        )
        for ad in ads:
            attempt += 1
            try:
                inst = compute.launch_instance(
                    oci.core.models.LaunchInstanceDetails(
                        availability_domain=ad.name, **details_base)).data
                log(f"LAUNCHED {ocpus}cpu/{mem}gb in {ad.name} "
                    f"after {attempt} attempts: {inst.id}")
                break
            except oci.exceptions.ServiceError as e:
                if e.status == 500 and "capacity" in (e.message or "").lower():
                    log(f"attempt {attempt}: {ad.name} out of capacity")
                elif e.status == 429:
                    log(f"attempt {attempt}: rate limited, backing off 120s")
                    time.sleep(120)
                elif e.status == 404:
                    # shape not offered in this AD — skip it permanently
                    log(f"attempt {attempt}: {ad.name} does not offer A1, skipping")
                    ads = [a for a in ads if a.name != ad.name]
                else:
                    log(f"attempt {attempt}: {ad.name} ERROR {e.status} "
                        f"{e.code}: {e.message}")
                    if e.status in (400, 401):
                        sys.exit(f"fatal: {e.message}")
            except (oci.exceptions.RequestException,
                    oci.exceptions.ConnectTimeout, OSError) as e:
                # laptop wifi/DNS blip — never die on transient network errors
                log(f"attempt {attempt}: network error ({type(e).__name__}), "
                    "retrying in 60s")
                time.sleep(60)
        if inst is None:
            time.sleep(RETRY_SLEEP)

# ---- wait for RUNNING and print the public IP ------------------------------
inst = oci.wait_until(compute, compute.get_instance(inst.id),
                      "lifecycle_state", "RUNNING",
                      max_wait_seconds=1200).data
log("instance RUNNING")
va = compute.list_vnic_attachments(
    compartment_id=tenancy, instance_id=inst.id).data[0]
vnic = vnet.get_vnic(va.vnic_id).data
log(f"PUBLIC IP: {vnic.public_ip}")
print("RESULT_PUBLIC_IP=" + str(vnic.public_ip), flush=True)
