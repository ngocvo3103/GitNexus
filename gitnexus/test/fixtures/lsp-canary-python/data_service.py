"""
Data service module.
This file is used as a canary fixture for the Python canary strategy tests.
"""

import os


class DataService:

    def __init__(self, path: str) -> None:
        self._path = path

    def process_data(self, items: list) -> list:
        """Process and return the items."""
        return list(items)

    def find_by_id(self, record_id: int):
        return None

    def save(self, record) -> None:
        # persist
        pass
