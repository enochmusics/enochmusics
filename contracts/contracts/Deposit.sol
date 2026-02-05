// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract Deposit {
    event Deposit(address indexed payer, uint256 amountWei, bytes32 indexed orderId);

    receive() external payable {
        revert("Use deposit()");
    }

    function deposit(bytes32 orderId) external payable {
        require(msg.value > 0, "amount required");
        emit Deposit(msg.sender, msg.value, orderId);
    }
}
