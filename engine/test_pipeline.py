"""Run the isolated production regression suite; never clear user data."""
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
from test_app import FactoryTests
import unittest
if __name__ == '__main__':
    unittest.main()
