#!/usr/bin/env python3
import os
import argparse
import sys
from pathlib import Path
import pydicom
from pydicom.uid import generate_uid

def mutate_dicom(dataset: pydicom.Dataset, patient_id: str, patient_name: str, study_uid_map: dict, series_uid_map: dict) -> pydicom.Dataset:
    """
    Mutates a DICOM dataset in-place to anonymize/synthesize it for a new patient.
    Guarantees unique UIDs while preserving original study/series relationships.
    """
    dataset.PatientID = patient_id
    dataset.PatientName = patient_name

    # Update StudyInstanceUID while preserving study mapping for the patient
    orig_study_uid = dataset.get("StudyInstanceUID")
    if orig_study_uid:
        if orig_study_uid not in study_uid_map:
            study_uid_map[orig_study_uid] = generate_uid()
        dataset.StudyInstanceUID = study_uid_map[orig_study_uid]

    # Update SeriesInstanceUID while preserving series mapping for the patient
    orig_series_uid = dataset.get("SeriesInstanceUID")
    if orig_series_uid:
        if orig_series_uid not in series_uid_map:
            series_uid_map[orig_series_uid] = generate_uid()
        dataset.SeriesInstanceUID = series_uid_map[orig_series_uid]

    # Generate a completely new SOPInstanceUID
    new_sop_uid = generate_uid()
    dataset.SOPInstanceUID = new_sop_uid

    if hasattr(dataset, "file_meta") and dataset.file_meta is not None:
        dataset.file_meta.MediaStorageSOPInstanceUID = new_sop_uid

    return dataset

def find_dicom_files(input_dir: Path) -> list[Path]:
    """
    Recursively scans the input directory and returns paths of valid DICOM files
    by checking for the 'DICM' magic bytes at offset 128.
    """
    dicom_files = []
    if not input_dir.exists() or not input_dir.is_dir():
        return []

    for path in input_dir.rglob("*"):
        if path.is_file():
            try:
                with open(path, "rb") as f:
                    f.seek(128)
                    magic = f.read(4)
                    if magic == b"DICM":
                        dicom_files.append(path)
            except Exception:
                pass
    return dicom_files

def main():
    parser = argparse.ArgumentParser(description="Generador de datos de prueba DICOM sintéticos.")
    parser.add_argument("--input", default="./data.example", help="Directorio con archivos DICOM base.")
    parser.add_argument("--output", default="./data/staging/dicom", help="Directorio de destino.")
    parser.add_argument("--count", type=int, default=1, help="Cantidad de pacientes sintéticos a generar.")
    args = parser.parse_args()

    input_path = Path(args.input)
    output_path = Path(args.output)

    dicom_files = find_dicom_files(input_path)
    if not dicom_files:
        print(f"Error: No se encontraron archivos DICOM válidos en '{input_path.resolve()}'", file=sys.stderr)
        sys.exit(1)

    output_path.mkdir(parents=True, exist_ok=True)

    print(f"Encontrados {len(dicom_files)} archivos DICOM base.")
    print(f"Generando datos para {args.count} paciente(s)...")

    generated_count = 0
    for i in range(1, args.count + 1):
        patient_id = f"SYN-{i:03d}"
        patient_name = f"Synthetic Patient {i}"

        study_uid_map = {}
        series_uid_map = {}

        for file_path in dicom_files:
            try:
                ds = pydicom.dcmread(file_path)
                mutated_ds = mutate_dicom(ds, patient_id, patient_name, study_uid_map, series_uid_map)

                out_filename = f"{patient_id}_{mutated_ds.SOPInstanceUID}.dcm"
                out_filepath = output_path / out_filename

                mutated_ds.save_as(out_filepath)
                generated_count += 1
            except Exception as e:
                print(f"Error al procesar '{file_path}': {e}", file=sys.stderr)

    print(f"Proceso completado. Se generaron {generated_count} archivos en '{output_path.resolve()}'")

if __name__ == "__main__":
    main()
