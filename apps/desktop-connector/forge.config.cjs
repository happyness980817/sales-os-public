module.exports = {
  packagerConfig: {
    asar: true,
    name: 'SALES-OS Connect',
    executableName: 'salesos-connect',
    icon: 'dist/icon.ico',
    appBundleId: 'com.salesos.connect',
    ignore: [/^\/src($|\/)/, /^\/tests($|\/)/, /^\/scripts($|\/)/, /^\/out($|\/)/, /^\/\.runtime($|\/)/, /\.env/],
  },
  makers: [{ name: '@electron-forge/maker-squirrel', config: { name: 'salesos_connect', setupExe: 'SALES-OS-Connect-Setup.exe' } }],
};
