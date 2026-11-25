import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('sync_hosts', Path(__file__).with_name('sync-hosts.py'))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class HostMapTests(unittest.TestCase):
    def test_deduplicates_without_wildcard_or_default_route(self):
        self.assertEqual(sync.host_entries(['status.customer.com', 'status.customer.com'], {'api.example.com'}), b'status.customer.com 127.0.0.1:8443;\n')

    def test_rejects_existing_application_host(self):
        with self.assertRaises(ValueError):
            sync.host_entries(['api.example.com'], {'api.example.com'})

    def test_rejects_config_injection_and_non_hosts(self):
        for host in ['a.customer.com; default evil;', 'a.customer.com\n', '*.customer.com', 'https://status.customer.com', 'status..com', 123, 'customer.com']:
            with self.subTest(host=host), self.assertRaises(ValueError):
                sync.host_entries([host], set())

    def test_rejects_malformed_response(self):
        with self.assertRaises(ValueError):
            sync.host_entries({'hostname': 'status.customer.com'}, set())

if __name__ == '__main__':
    unittest.main()
