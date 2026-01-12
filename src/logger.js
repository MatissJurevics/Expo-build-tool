const ora = require("ora");
const chalk = require("chalk");

let spinner = null;

function stopSpinner(success = true) {
  if (spinner) {
    if (success) {
      spinner.succeed();
    } else {
      spinner.fail();
    }
    spinner = null;
  }
}

function startSpinner(text) {
  stopSpinner(true); // Stop previous if exists
  spinner = ora(text).start();
}

function updateSpinner(text) {
  if (spinner) {
    spinner.text = text;
  } else {
    spinner = ora(text).start();
  }
}

function logInfo(message) {
  if (spinner) {
    spinner.stop();
    console.log(chalk.blue("ℹ") + " " + message);
    spinner.start();
  } else {
    console.log(chalk.blue("ℹ") + " " + message);
  }
}

function logSuccess(message) {
  if (spinner) {
    spinner.succeed(message);
    spinner = null;
  } else {
    console.log(chalk.green("✔") + " " + message);
  }
}

function logWarn(message) {
  if (spinner) {
    spinner.stop();
    console.log(chalk.yellow("⚠") + " " + message);
    spinner.start();
  } else {
    console.log(chalk.yellow("⚠") + " " + message);
  }
}

function logError(message) {
  if (spinner) {
    spinner.fail(message);
    spinner = null;
  } else {
    console.log(chalk.red("✖") + " " + message);
  }
}

module.exports = {
  logInfo,
  logSuccess,
  logWarn,
  logError,
  startSpinner,
  updateSpinner,
  stopSpinner
};
