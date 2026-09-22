// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
/// A payee that refuses ETH, for the vault's tests only.
contract NoEth { receive() external payable { revert("no"); } }
