package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/hkjarral/ava-ai-voice-agent-for-asterisk/cli/internal/troubleshoot"
	"github.com/spf13/cobra"
)

var (
	rcaCallID string
	rcaJSON   bool
	rcaLLM    bool
	rcaLocal  bool
)

var rcaCmd = &cobra.Command{
	Use:   "rca [call_id]",
	Short: "Post-call root cause analysis",
	Long: `Analyze the most recent call (or a specific call ID) and print an RCA report.

Use --local to generate a Community Test Matrix submission template
for the last local-provider call (collects hardware, model config,
and latency data automatically).

This is the recommended post-call troubleshooting command.`,
	Args: cobra.MaximumNArgs(1),
	RunE: func(cmd *cobra.Command, args []string) error {
		// --local mode: generate community test matrix submission
		if rcaLocal {
			return runLocalTestReport(cmd)
		}

		callID := rcaCallID
		if callID == "" && len(args) == 1 {
			callID = args[0]
		}
		if callID == "" {
			callID = "last"
		}

		runner := troubleshoot.NewRunner(
			callID,
			"",     // symptom
			false,  // interactive
			false,  // collectOnly
			false,  // noLLM (auto gating will skip healthy calls)
			rcaLLM, // forceLLM
			false,  // list
			rcaJSON,
			verbose,
		)
		err := runner.Run()
		if rcaJSON && err != nil {
			os.Exit(1)
		}
		return err
	},
}

// runLocalTestReport shells out to scripts/local_test_report.py
func runLocalTestReport(cmd *cobra.Command) error {
	// Find project root (walk up from cwd looking for .env or docker-compose.yml)
	projectRoot, err := findProjectRoot()
	if err != nil {
		return fmt.Errorf("could not find project root: %w", err)
	}

	scriptPath := filepath.Join(projectRoot, "scripts", "local_test_report.py")
	if _, err := os.Stat(scriptPath); os.IsNotExist(err) {
		return fmt.Errorf("script not found: %s\nMake sure you're running from the project directory", scriptPath)
	}

	pyArgs := []string{scriptPath, "--project-root", projectRoot}
	if rcaJSON {
		pyArgs = append(pyArgs, "--json")
	}

	pyCmd := exec.Command("python3", pyArgs...)
	pyCmd.Stdout = os.Stdout
	pyCmd.Stderr = os.Stderr
	pyCmd.Dir = projectRoot

	if err := pyCmd.Run(); err != nil {
		return fmt.Errorf("local test report failed: %w", err)
	}
	return nil
}

// findProjectRoot walks up from cwd looking for project markers
func findProjectRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		// Check for project markers
		for _, marker := range []string{"docker-compose.yml", ".env", "main.py"} {
			if _, err := os.Stat(filepath.Join(dir, marker)); err == nil {
				return dir, nil
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	// Fallback to cwd
	cwd, _ := os.Getwd()
	return cwd, nil
}

func init() {
	rcaCmd.Flags().StringVar(&rcaCallID, "call", "", "analyze specific call ID (default: last)")
	rcaCmd.Flags().BoolVar(&rcaLLM, "llm", false, "force LLM analysis (even for healthy calls)")
	rcaCmd.Flags().BoolVar(&rcaJSON, "json", false, "output as JSON (JSON only)")
	rcaCmd.Flags().BoolVar(&rcaLocal, "local", false, "generate Community Test Matrix submission for local provider")
	rootCmd.AddCommand(rcaCmd)
}
