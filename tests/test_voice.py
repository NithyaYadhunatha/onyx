import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "voice"))

import voice  # noqa: E402


class SpeechTextTests(unittest.TestCase):
    def test_cleaning(self):
        out = voice.clean_for_speech(r"Done! Spent **₹1,250** at [Amazon](https://a.com). Saved to C:\Users\x\a.xlsx")
        self.assertNotIn("*", out)
        self.assertNotIn("https", out)
        self.assertIn("rupees", out)
        self.assertIn("Amazon", out)
        self.assertIn("the file", out)

    def test_answers(self):
        self.assertTrue(voice.YES.search("yes go ahead"))
        self.assertTrue(voice.NO.search("no don't"))
        self.assertTrue(voice.TASK.search("yes for this task"))
        self.assertFalse(voice.YES.search("hmm"))
        self.assertTrue(voice.STOP_WORDS.match("Stop."))
        self.assertFalse(voice.STOP_WORDS.match("stop the music in spotify"))


if __name__ == "__main__":
    unittest.main()
