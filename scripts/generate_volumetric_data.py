#!/usr/bin/env python3
import os
from pathlib import Path
import numpy as np
import pydicom
from pydicom.dataset import FileDataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

def generate_sphere_volume(shape=(64, 64, 64), radius=16, blur=4):
    """
    Generates a 3D volume with a blurred sphere in the center.
    """
    nz, ny, nx = shape
    z, y, x = np.ogrid[-nz/2:nz/2, -ny/2:ny/2, -nx/2:nx/2]
    r = np.sqrt(x**2 + y**2 + z**2)
    volume = np.clip((radius + blur - r) / (2 * blur), 0, 1)
    return (volume * 1000).astype(np.uint16)

def create_slice(z, slice_data, study_uid, series_uid, output_dir):
    """
    Creates a single DICOM slice for the volume with correct preamble and magic bytes.
    """
    sop_instance = generate_uid()
    filename = f"SYN-VOLUMETRIC_{sop_instance}.dcm"
    out_filepath = output_dir / filename

    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = '1.2.840.10008.5.1.4.1.1.2'  # CT Image Storage
    file_meta.MediaStorageSOPInstanceUID = sop_instance
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

    # Create the dataset using FileDataset to guarantee the 128-byte preamble and DICM magic bytes are written
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
    spacing_z = 2.0
    ds.ImagePositionPatient = [0.0, 0.0, float(z * spacing_z)]
    ds.SliceThickness = spacing_z
    ds.PixelSpacing = [1.0, 1.0]
    ds.InstanceNumber = z + 1

    ds.PixelData = slice_data.tobytes()

    # Save forcing standard DICOM format
    ds.save_as(out_filepath, write_like_original=False)

def main():
    output_dir = Path("./data/staging/dicom/SYN-VOLUMETRIC")
    output_dir.mkdir(parents=True, exist_ok=True)

    print("Generando volumen 3D sintético...")
    volume = generate_sphere_volume()

    study_uid = generate_uid()
    series_uid = generate_uid()

    num_slices = volume.shape[0]
    for z in range(num_slices):
        slice_data = volume[z, :, :]
        create_slice(z, slice_data, study_uid, series_uid, output_dir)

    print(f"Volumen generado con éxito. Se guardaron {num_slices} cortes en '{output_dir.resolve()}'")

if __name__ == "__main__":
    main()
