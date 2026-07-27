#!/usr/bin/env python3
import os
from pathlib import Path
import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

def generate_complex_volume(shape=(128, 128, 128)):
    """
    Generates a 3D volumetric array with multiple intersecting geometric shapes
    and distinct radiological densities (simulated CT Hounsfield Units mapped to uint16).

    Shapes included:
    - Large hollow sphere (soft tissue density ~1000)
    - Off-center solid cube (bone density ~3000)
    - Off-center Z-aligned cylinder (metal density ~5000)
    - Off-center sphere core (high contrast lesion ~2000)
    """
    nz, ny, nx = shape
    z, y, x = np.ogrid[-nz/2:nz/2, -ny/2:ny/2, -nx/2:nx/2]

    volume = np.zeros(shape, dtype=np.float32)

    # 1. Outer hollow sphere (Soft tissue density ~ 1000)
    r = np.sqrt(x**2 + y**2 + z**2)
    outer_radius = min(shape) * 0.42  # ~53.7 voxels
    inner_radius = min(shape) * 0.28  # ~35.8 voxels
    soft_tissue_mask = (r <= outer_radius) & (r >= inner_radius)
    volume[soft_tissue_mask] = 1000.0

    # 2. Solid off-center cube (Bone density ~ 3000)
    cube_half_side = min(shape) * 0.11  # ~14 voxels (28x28x28 cube)
    cube_center = (-min(shape)*0.12, -min(shape)*0.12, min(shape)*0.06)  # (-15, -15, 8)
    cube_mask = (
        (np.abs(x - cube_center[0]) <= cube_half_side) &
        (np.abs(y - cube_center[1]) <= cube_half_side) &
        (np.abs(z - cube_center[2]) <= cube_half_side)
    )
    volume[cube_mask] = 3000.0

    # 3. Off-center cylinder (Metal density ~ 5000) along Z-axis
    cyl_radius = min(shape) * 0.09  # ~11.5 voxels
    cyl_center = (min(shape)*0.14, min(shape)*0.14)  # (18, 18)
    cyl_height_half = min(shape) * 0.25  # ~32 voxels
    cyl_mask = (
        ((x - cyl_center[0])**2 + (y - cyl_center[1])**2 <= cyl_radius**2) &
        (np.abs(z) <= cyl_height_half)
    )
    volume[cyl_mask] = 5000.0

    # 4. Secondary sphere (High contrast lesion ~ 2000)
    lesion_radius = min(shape) * 0.09  # ~11.5 voxels
    lesion_center = (0.0, min(shape)*0.12, -min(shape)*0.14)  # (0, 15, -18)
    r_lesion = np.sqrt((x - lesion_center[0])**2 + (y - lesion_center[1])**2 + (z - lesion_center[2])**2)
    lesion_mask = r_lesion <= lesion_radius
    volume[lesion_mask] = 2000.0

    return np.clip(volume, 0, 65535).astype(np.uint16)

def create_slice(z, slice_data, study_uid, series_uid, output_dir, spacing_z=1.0, pixel_spacing=(1.0, 1.0)):
    """
    Creates a single DICOM slice for the volume with correct preamble, magic bytes,
    spatial positioning tags, and Instance Number.
    """
    sop_instance = generate_uid()
    filename = f"SYN-VOLUMETRIC_{sop_instance}.dcm"
    out_filepath = output_dir / filename

    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = '1.2.840.10008.5.1.4.1.1.2'  # CT Image Storage
    file_meta.MediaStorageSOPInstanceUID = sop_instance
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

    # Create dataset using FileDataset guaranteeing 128-byte preamble and DICM magic bytes
    ds = FileDataset(out_filepath, {}, file_meta=file_meta, preamble=b"\x00" * 128)
    ds.is_little_endian = True
    ds.is_implicit_VR = False

    ds.SOPClassUID = file_meta.MediaStorageSOPClassUID
    ds.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID

    # Patient & Study Attributes
    ds.PatientName = "Synthetic Volumetric"
    ds.PatientID = "SYN-VOLUMETRIC"
    ds.PatientSex = "O"
    ds.PatientAge = "030Y"
    ds.StudyInstanceUID = study_uid
    ds.SeriesInstanceUID = series_uid
    ds.Modality = "CT"
    ds.StudyDate = "20260710"

    # Image pixel metadata
    ds.Rows = slice_data.shape[0]
    ds.Columns = slice_data.shape[1]
    ds.SamplesPerPixel = 1
    ds.PhotometricInterpretation = "MONOCHROME2"
    ds.BitsAllocated = 16
    ds.BitsStored = 16
    ds.HighBit = 15
    ds.PixelRepresentation = 0

    # Spatial metadata
    ds.ImageOrientationPatient = [1.0, 0.0, 0.0, 0.0, 1.0, 0.0]  # Axial
    ds.ImagePositionPatient = [0.0, 0.0, float(z * spacing_z)]
    ds.SliceThickness = float(spacing_z)
    ds.PixelSpacing = [float(pixel_spacing[0]), float(pixel_spacing[1])]
    ds.InstanceNumber = z + 1

    ds.PixelData = slice_data.tobytes()

    # Save forcing standard DICOM format
    ds.save_as(out_filepath, write_like_original=False)

def main():
    output_dir = Path("./data/staging/dicom/SYN-VOLUMETRIC")
    output_dir.mkdir(parents=True, exist_ok=True)

    shape = (128, 128, 128)
    spacing_z = 1.0
    pixel_spacing = (1.0, 1.0)

    print(f"Generando volumen 3D sintético complejo ({shape[0]}x{shape[1]}x{shape[2]})...")
    volume = generate_complex_volume(shape=shape)

    study_uid = generate_uid()
    series_uid = generate_uid()

    num_slices = volume.shape[0]
    for z in range(num_slices):
        slice_data = volume[z, :, :]
        create_slice(z, slice_data, study_uid, series_uid, output_dir, spacing_z=spacing_z, pixel_spacing=pixel_spacing)

    print(f"Volumen generado con éxito. Se guardaron {num_slices} cortes en '{output_dir.resolve()}'")

if __name__ == "__main__":
    main()
