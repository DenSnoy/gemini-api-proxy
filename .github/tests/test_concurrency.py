from pathlib import Path
import unittest
import yaml

ROOT=Path(__file__).resolve().parents[2]

class GeminiQueueTests(unittest.TestCase):
    def test_only_shared_catalog_writes_are_queued(self):
        folder=ROOT/'.github/workflows'
        refresh=yaml.load((folder/'gemini-model-catalog-refresh.yml').read_text(),Loader=yaml.BaseLoader)
        queue=refresh['jobs']['refresh']['concurrency']
        self.assertEqual(queue['queue'],'max')
        self.assertEqual(queue['cancel-in-progress'],'false')
        self.assertIn('gemini-model-catalog-',queue['group'])
        for filename in ('gemini-fast-text.yml','gemini-fast-decision.yml','gemini-live-fast.yml','gemini-live-audio.yml'):
            workflow=yaml.load((folder/filename).read_text(),Loader=yaml.BaseLoader)
            self.assertNotIn('concurrency',workflow,filename)
            for job in workflow['jobs'].values():self.assertNotIn('concurrency',job,filename)
