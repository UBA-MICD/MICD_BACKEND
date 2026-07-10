#!/usr/bin/env python3
import unittest
import tempfile
from pathlib import Path
import pydicom
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid

from generate_synthetic_data import mutate_dicom, find_dicom_files

class TestGenerateSyntheticData(unittest.TestCase):

    def setUp(self):
        # Create a mock DICOM dataset in memory
        self.file_meta = FileMetaDataset()
        self.file_meta.MediaStorageSOPClassUID = '1.2.840.10008.5.1.4.1.1.2'
        self.file_meta.MediaStorageSOPInstanceUID = '1.2.3.4.5.6.original'
        self.file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

        self.ds = Dataset()
        self.ds.file_meta = self.file_meta
        self.ds.is_little_endian = True
        self.ds.is_implicit_VR = False
        self.ds.PatientID = "ORIG-ID"
        self.ds.PatientName = "Original Patient"
        self.ds.StudyInstanceUID = "1.2.3.4.5.6.original.study"
        self.ds.SeriesInstanceUID = "1.2.3.4.5.6.original.series"
        self.ds.SOPInstanceUID = "1.2.3.4.5.6.original"

    def test_mutate_dicom_changes_patient_info(self):
        study_map = {}
        series_map = {}
        mutated = mutate_dicom(self.ds, "SYN-001", "Synthetic Patient 1", study_map, series_map)

        self.assertEqual(mutated.PatientID, "SYN-001")
        self.assertEqual(mutated.PatientName, "Synthetic Patient 1")

    def test_mutate_dicom_changes_uids(self):
        study_map = {}
        series_map = {}

        orig_study = self.ds.StudyInstanceUID
        orig_series = self.ds.SeriesInstanceUID
        orig_sop = self.ds.SOPInstanceUID
        orig_meta_sop = self.ds.file_meta.MediaStorageSOPInstanceUID

        mutated = mutate_dicom(self.ds, "SYN-001", "Synthetic Patient 1", study_map, series_map)

        self.assertNotEqual(mutated.StudyInstanceUID, orig_study)
        self.assertNotEqual(mutated.SeriesInstanceUID, orig_series)
        self.assertNotEqual(mutated.SOPInstanceUID, orig_sop)
        self.assertEqual(mutated.file_meta.MediaStorageSOPInstanceUID, mutated.SOPInstanceUID)
        self.assertNotEqual(mutated.file_meta.MediaStorageSOPInstanceUID, orig_meta_sop)

    def test_mutate_dicom_maintains_study_and_series_correlations(self):
        study_map = {}
        series_map = {}

        # Create two separate datasets belonging to the same study and series
        ds1 = Dataset()
        ds1.file_meta = FileMetaDataset()
        ds1.file_meta.MediaStorageSOPInstanceUID = "sop-1"
        ds1.StudyInstanceUID = "study-abc"
        ds1.SeriesInstanceUID = "series-xyz"
        ds1.SOPInstanceUID = "sop-1"

        ds2 = Dataset()
        ds2.file_meta = FileMetaDataset()
        ds2.file_meta.MediaStorageSOPInstanceUID = "sop-2"
        ds2.StudyInstanceUID = "study-abc"
        ds2.SeriesInstanceUID = "series-xyz"
        ds2.SOPInstanceUID = "sop-2"

        mut1 = mutate_dicom(ds1, "SYN-001", "Synthetic Patient 1", study_map, series_map)
        mut2 = mutate_dicom(ds2, "SYN-001", "Synthetic Patient 1", study_map, series_map)

        # The new study and series UIDs should match across files (since they shared the same originals)
        self.assertEqual(mut1.StudyInstanceUID, mut2.StudyInstanceUID)
        self.assertEqual(mut1.SeriesInstanceUID, mut2.SeriesInstanceUID)

        # But their SOP Instance UIDs must be distinct
        self.assertNotEqual(mut1.SOPInstanceUID, mut2.SOPInstanceUID)

    def test_find_dicom_files_checks_magic_bytes(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmpdir_path = Path(tmpdir)

            # 1. Non-DICOM file (no header)
            non_dicom = tmpdir_path / "test.txt"
            non_dicom.write_text("just some text")

            # 2. Valid DICOM file structure (128 bytes padding + 'DICM' magic bytes)
            dicom_file = tmpdir_path / "image.dcm"
            with open(dicom_file, "wb") as f:
                f.write(b"\x00" * 128)
                f.write(b"DICM")
                f.write(b"rest of file data...")

            found = find_dicom_files(tmpdir_path)
            self.assertEqual(len(found), 1)
            self.assertEqual(found[0].name, "image.dcm")

    def test_find_dicom_files_returns_empty_when_empty_or_missing(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            found = find_dicom_files(Path(tmpdir))
            self.assertEqual(found, [])

        found_missing = find_dicom_files(Path("/non/existent/path"))
        self.assertEqual(found_missing, [])

if __name__ == "__main__":
    unittest.main()
