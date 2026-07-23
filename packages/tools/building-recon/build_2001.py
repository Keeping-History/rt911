"""Pure transforms for the 2001 building-footprint pipeline.

No network, DB, or S3 here — everything in this module is a deterministic
function of its inputs so it is unit-testable without external services.
building_recon/flow.py wires these to the I/O modules.
"""
