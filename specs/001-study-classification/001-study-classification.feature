Feature: Study pathology classification (backend)
  Categories live in a backend-owned catalog table (id + stable key, no descriptions).
  A study references a category by id at upload; the listing returns the id and key.

  Background:
    Given the backend stack is running
    And I am authenticated as a "medico"

  Scenario: The catalog is served
    When I GET /api/v1/pathologies
    Then the response status is 200
    And the body contains these keys: acv, hemorragia, tumor, desmielinizante, normales, otros
    And each entry has a numeric id

  Scenario: Upload a study classified by a valid catalog id
    Given the catalog id for key "acv" is <id>
    When I upload a valid DICOM with classification_id <id>
    Then the response status is 201
    And the studies listing shows that study with classification_key "acv"

  Scenario: Reject an unknown classification id
    When I upload a valid DICOM with classification_id 999999
    Then the response status is 400
    And the study is not created

  Scenario: Reject a non-integer classification id
    When I upload a valid DICOM with classification_id "abc"
    Then the response status is 400
    And the study is not created

  Scenario: Classification is optional
    When I upload a valid DICOM with no classification_id field
    Then the response status is 201
    And the studies listing shows that study with classification_id null and classification_key null
